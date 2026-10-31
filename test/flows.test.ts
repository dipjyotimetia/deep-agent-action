import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { runImplement } from "../src/flows/implement.js";
import { reviewFromResult } from "../src/flows/review.js";
import { createShellRunner, streamIntoRecord, type FlowParams } from "../src/flows/shared.js";
import { DockerShellRunner, LocalShellRunner } from "../src/agent/shellExec.js";
import { DEFAULT_ALLOWED_COMMANDS, DEFAULT_DENIED_COMMANDS } from "../src/config.js";
import type { Config, RunRecord } from "../src/types.js";
import { makeContext } from "./mockContext.js";
import { ScriptedModel, toolCall } from "./scriptedModel.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "da-flows-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync(join(root, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

const record = (): RunRecord => ({
  status: "skipped",
  mode: "agent",
  model: "m",
  plan: [],
  toolCalls: [],
  filesChanged: [],
});

const config = {
  model: "anthropic:claude-sonnet-5",
  commentDebounceMs: 0,
  recursionLimit: 100,
  maxRepeatedToolCalls: 8,
  requirePushApproval: true,
  verifiedCommits: false,
  protectedPaths: [".deepagents/**"],
  allowedCommands: DEFAULT_ALLOWED_COMMANDS,
  deniedCommands: DEFAULT_DENIED_COMMANDS,
  shellTimeoutSeconds: 5,
  shellSandbox: "none",
  shellSandboxNetwork: "none",
} as unknown as Config;

function params(overrides: Partial<FlowParams> = {}): FlowParams {
  return {
    octokit: {} as FlowParams["octokit"],
    ctx: makeContext({ entityNumber: undefined }),
    rootDir: repo(),
    token: "test-token",
    tokenSource: "github_token",
    model: new ScriptedModel([]) as BaseChatModel,
    modelFor: () => new ScriptedModel([]),
    instruction: "do it",
    repoConfig: {},
    config,
    record: record(),
    commentId: undefined,
    url: "https://example.invalid/run",
    mcpTools: [],
    renderBody: () => "body",
    priorMemory: [],
    branchSuffix: "suffix",
    artifactDir: mkdtempSync(join(tmpdir(), "da-flows-artifacts-")),
    ...overrides,
  };
}

// Point the landing's push at a closed local port, so it fails without any network.
const originalServer = process.env.GITHUB_SERVER_URL;
beforeEach(() => {
  process.env.GITHUB_SERVER_URL = "http://127.0.0.1:9";
});
afterEach(() => {
  if (originalServer === undefined) delete process.env.GITHUB_SERVER_URL;
  else process.env.GITHUB_SERVER_URL = originalServer;
});

describe("streamIntoRecord", () => {
  test("a tracking-comment failure doesn't reach the agent run", async () => {
    const p = params({
      commentId: 1,
      octokit: {
        rest: {
          issues: {
            updateComment: async () => {
              throw new Error("GitHub is having a moment");
            },
          },
        },
      } as unknown as FlowParams["octokit"],
    });
    const agent = {
      stream: async function* () {
        yield {
          todos: [{ content: "work", status: "in_progress" }],
          messages: [
            new AIMessage({ content: "", tool_calls: [{ name: "ls", args: {}, id: "1" }] }),
          ],
        };
        yield {
          todos: [{ content: "work", status: "completed" }],
          messages: [new AIMessage("ok")],
        };
      },
    };
    const result = await streamIntoRecord(p, agent, {});
    expect(result.summary).toBe("ok");
    expect(p.record.plan).toEqual([{ content: "work", status: "completed" }]);
  });

  test("records cost even when no budget is configured", async () => {
    const p = params();
    const agent = {
      stream: async function* (_input: unknown, options: any) {
        options.callbacks[0].handleLLMEnd({
          generations: [
            [
              {
                text: "",
                message: { usage_metadata: { input_tokens: 1_000_000, output_tokens: 0 } },
              },
            ],
          ],
        });
        yield { messages: [new AIMessage("ok")] };
      },
    };
    await streamIntoRecord(p, agent, {});
    expect(p.record.tokens).toEqual({ input: 1_000_000, output: 0 });
    expect(p.record.costUsd).toBe(3);
  });
});

describe("reviewFromResult", () => {
  const base = {
    todos: [],
    summary: "closing text",
    tokens: { input: 0, output: 0 },
    activities: [],
  };

  test("a run with no structured response fails instead of posting an empty review", () => {
    expect(() => reviewFromResult(base)).toThrow("No review was posted");
  });

  test("a stopped run says why no review was posted", () => {
    expect(() =>
      reviewFromResult({ ...base, stopped: "stalled", stopDetail: "Repeated tool call" }),
    ).toThrow("Repeated tool call");
  });

  test("uses the response and drops unusable findings", () => {
    const review = reviewFromResult({
      ...base,
      structuredResponse: {
        summary: "",
        findings: [
          { path: "a.ts", line: 1, body: "real" },
          { path: "", line: 0, body: "" },
        ],
      },
    });
    expect(review.summary).toBe("closing text");
    expect(review.findings.map((f) => f.body)).toEqual(["real"]);
  });

  test("a genuine clean review is not treated as missing", () => {
    expect(
      reviewFromResult({ ...base, structuredResponse: { summary: "LGTM", findings: [] } }),
    ).toEqual({ summary: "LGTM", findings: [] });
  });
});

describe("createShellRunner", () => {
  test("uses the host runner unless the workflow opts into Docker", () => {
    expect(createShellRunner(config, tmpdir())).toBeInstanceOf(LocalShellRunner);
    const docker = createShellRunner(
      { ...config, shellSandbox: "docker", shellSandboxImage: "alpine:3" },
      tmpdir(),
    );
    expect(docker).toBeInstanceOf(DockerShellRunner);
    return docker.terminateAll();
  });
});

describe("runImplement", () => {
  /** Edits a file, then has the provider fail. */
  class FailingModel extends ScriptedModel {
    constructor() {
      super([
        () => toolCall("write_file", { file_path: "/finished.txt", content: "done\n" }, "w"),
        () => {
          throw new Error("provider exploded");
        },
      ]);
    }
  }

  test("a provider failure reports the original error after trying to save the edits", async () => {
    const p = params({ model: new FailingModel() });
    await expect(runImplement(p)).rejects.toThrow("provider exploded");
    // The push can't succeed here, but the control-plane commit proves landing ran.
    const log = execFileSync("git", ["log", "--name-only", "--format=%s", "-1"], {
      cwd: p.rootDir,
      encoding: "utf8",
    });
    expect(log).toContain("finished.txt");
    expect(log).toContain("Deep Agent: do it");
  }, 30_000);

  test("restores Git and refuses protected changes before landing anything", async () => {
    const rootDir = repo();
    const model = new ScriptedModel([
      () =>
        toolCall(
          "execute",
          {
            command:
              "mkdir -p .deepagents && echo hijack > .deepagents/AGENTS.md && git add -A && echo x > b.txt",
          },
          "e",
        ),
    ]);
    const p = params({ rootDir, model });
    await expect(runImplement(p)).rejects.toThrow("Refusing to publish protected paths");
    expect(existsSync(join(rootDir, "b.txt"))).toBe(true);
  }, 30_000);

  test("nothing the agent started keeps running after the flow ends", async () => {
    const rootDir = repo();
    const model = new ScriptedModel([
      () => toolCall("execute", { command: "(sleep 0.8; touch late.txt) >/dev/null 2>&1 &" }, "bg"),
    ]);
    const p = params({ rootDir, model });
    await runImplement(p).catch(() => {});
    await Bun.sleep(1_100);
    expect(existsSync(join(rootDir, "late.txt"))).toBe(false);
    expect(readFileSync(join(rootDir, "a.txt"), "utf8")).toBe("x\n");
  }, 30_000);
});

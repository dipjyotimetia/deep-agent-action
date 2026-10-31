import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { buildAgent, type BuildAgentOptions } from "../src/agent/createAgent.js";
import { LocalShellRunner } from "../src/agent/shellExec.js";
import { runAgentStream } from "../src/agent/stream.js";
import { DEFAULT_ALLOWED_COMMANDS, DEFAULT_DENIED_COMMANDS } from "../src/config.js";
import { ScriptedModel, toolCall, type ScriptStep } from "./scriptedModel.js";

/**
 * Contract tests against the REAL deepagents graph, driven by a scripted model.
 * Unit tests that mock the stream cannot notice when an upstream release changes
 * what the harness provides; these fail in CI when it does.
 */

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "da-contract-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  mkdirSync(join(root, ".deepagents"));
  writeFileSync(join(root, ".deepagents/AGENTS.md"), "GUIDANCE_SENTINEL\n");
  writeFileSync(join(root, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

const gitStatus = (root: string) =>
  execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: root, encoding: "utf8" }).trim();

const common = (rootDir: string, model: ScriptedModel) => ({
  model,
  rootDir,
  systemPrompt: "contract",
  allowedCommands: DEFAULT_ALLOWED_COMMANDS,
  deniedCommands: DEFAULT_DENIED_COMMANDS,
  shellTimeoutSeconds: 5,
  toolCallRecord: [],
});

const input = { messages: [{ role: "user", content: "go" }] };
const streamOpts = { threadId: "acme/widgets#1", debounceMs: 0, recursionLimit: 200 };

function implement(root: string, script: ScriptStep[], extra: Partial<BuildAgentOptions> = {}) {
  const model = new ScriptedModel(script);
  const agent = buildAgent({
    ...common(root, model),
    mode: "implement",
    ...extra,
  } as BuildAgentOptions);
  return { model, agent };
}

const mcpTool = tool(async () => "ok", {
  name: "mcp_lookup",
  description: "lookup",
  schema: z.object({}),
});
const specialist = {
  name: "specialist",
  description: "a specialist",
  systemPrompt: "specialize",
  mcpTools: ["mcp_lookup"],
};

/** Submit a review through whichever structured-output tool the harness bound. */
const submitReview =
  (response: unknown): ScriptStep =>
  (tools) => {
    const name = tools.find((t) => t.startsWith("extract"));
    if (!name) throw new Error(`No structured-response tool in: ${tools.join(", ")}`);
    return toolCall(name, response as Record<string, unknown>, "submit");
  };

describe("implement mode tool surface", () => {
  test("exposes planning, editing, shell, and delegation tools", async () => {
    const { model, agent } = implement(repo(), []);
    await runAgentStream(agent, input, streamOpts);
    expect(model.seenTools[0]).toEqual(
      expect.arrayContaining([
        "write_todos",
        "read_file",
        "write_file",
        "edit_file",
        "execute",
        "task",
      ]),
    );
  });

  test("seeded todos survive into state, which is what `resume` relies on", async () => {
    const { agent } = implement(repo(), []);
    const result = await runAgentStream(
      agent,
      { ...input, todos: [{ content: "left over", status: "pending" }] },
      streamOpts,
    );
    expect(result.todos).toEqual([{ content: "left over", status: "pending" }]);
  });

  test("the agent's plan reaches the stream result", async () => {
    const { agent } = implement(repo(), [
      () => toolCall("write_todos", { todos: [{ content: "plan", status: "in_progress" }] }, "t"),
    ]);
    const result = await runAgentStream(agent, input, streamOpts);
    expect(result.todos).toEqual([{ content: "plan", status: "in_progress" }]);
  });
});

describe("permission floor reaches every agent", () => {
  const attempts = (prefix: string): ScriptStep[] => [
    () => toolCall("write_file", { file_path: "/.deepagents/new.md", content: "x" }, `${prefix}1`),
    () =>
      toolCall(
        "edit_file",
        { file_path: "/.deepagents/AGENTS.md", old_string: "GUIDANCE", new_string: "HIJACK" },
        `${prefix}2`,
      ),
    () =>
      toolCall(
        "edit_file",
        {
          file_path: "/.git/config",
          old_string: "[core]",
          new_string: "[core]\n\thijacked = true",
        },
        `${prefix}3`,
      ),
    () =>
      toolCall("write_file", { file_path: "/.git/hooks/pre-commit", content: "x" }, `${prefix}4`),
    () => toolCall("write_file", { file_path: "/secret/key", content: "x" }, `${prefix}5`),
  ];

  function assertUntouched(root: string): void {
    expect(existsSync(join(root, ".deepagents/new.md"))).toBe(false);
    expect(readFileSync(join(root, ".deepagents/AGENTS.md"), "utf8")).toContain("GUIDANCE");
    expect(readFileSync(join(root, ".git/config"), "utf8")).not.toContain("hijacked");
    expect(existsSync(join(root, ".git/hooks/pre-commit"))).toBe(false);
    expect(existsSync(join(root, "secret/key"))).toBe(false);
  }
  const deny = [{ operations: ["write" as const], paths: ["/secret/**"], mode: "deny" as const }];

  test("main agent", async () => {
    const root = repo();
    const { agent } = implement(root, attempts("m"), { filesystemPermissions: deny });
    await runAgentStream(agent, input, streamOpts);
    assertUntouched(root);
  });

  test("general-purpose subagent", async () => {
    const root = repo();
    const { agent } = implement(
      root,
      [
        () => toolCall("task", { description: "go", subagent_type: "general-purpose" }, "t"),
        ...attempts("g"),
      ],
      { filesystemPermissions: deny },
    );
    await runAgentStream(agent, input, streamOpts);
    assertUntouched(root);
  });

  test("custom subagent with no permissions of its own", async () => {
    const root = repo();
    const { agent } = implement(
      root,
      [
        () => toolCall("task", { description: "go", subagent_type: "specialist" }, "t"),
        ...attempts("c"),
      ],
      { filesystemPermissions: deny, extraTools: [mcpTool], subagents: [specialist] },
    );
    await runAgentStream(agent, input, streamOpts);
    assertUntouched(root);
  });

  test("custom subagent's own deny rules keep the floor ahead of them", async () => {
    const root = repo();
    const { agent } = implement(
      root,
      [
        () => toolCall("task", { description: "go", subagent_type: "specialist" }, "t"),
        ...attempts("r"),
        () => toolCall("write_file", { file_path: "/own/rule", content: "x" }, "own"),
      ],
      {
        filesystemPermissions: deny,
        extraTools: [mcpTool],
        subagents: [
          {
            ...specialist,
            filesystemPermissions: [{ operations: ["write"], paths: ["/own/**"], mode: "deny" }],
          },
        ],
      },
    );
    await runAgentStream(agent, input, streamOpts);
    assertUntouched(root);
    expect(existsSync(join(root, "own/rule"))).toBe(false);
  });
});

describe("harness artifacts stay out of the checkout", () => {
  test("an evicted tool result is not left to be committed, and stays readable", async () => {
    const root = repo();
    writeFileSync(join(root, "big.log"), "line of noise\n".repeat(60_000));
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "big"], { cwd: root });
    const artifactDir = mkdtempSync(join(tmpdir(), "da-artifacts-"));
    const { agent } = implement(
      root,
      [
        () => toolCall("execute", { command: "cat big.log" }, "big"),
        () => toolCall("read_file", { file_path: "/large_tool_results/big.txt", limit: 1 }, "back"),
      ],
      { artifactDir },
    );
    const result = await runAgentStream(agent, input, streamOpts);

    expect(gitStatus(root)).toBe("");
    expect(readdirSync(join(artifactDir, "large_tool_results"))).toEqual(["big.txt"]);
    expect(result.activities.map((a) => a.name)).toContain("read_file");
  });

  test("an evicted review prompt leaves review mode's checkout clean", async () => {
    const root = repo();
    const model = new ScriptedModel([submitReview({ summary: "ok", findings: [] })]);
    const agent = buildAgent({ ...common(root, model), mode: "review" });
    await runAgentStream(
      agent,
      { messages: [{ role: "user", content: "diff ".repeat(60_000) }] },
      streamOpts,
    );
    expect(gitStatus(root)).toBe("");
  });
});

describe("stall guard against the real graph", () => {
  test("a test-and-fix loop that keeps editing is not a stall", async () => {
    const root = repo();
    const script: ScriptStep[] = [];
    for (let i = 0; i < 10; i++) {
      script.push(() => toolCall("execute", { command: "echo test-run" }, `run${i}`));
      script.push(() =>
        toolCall("write_file", { file_path: `/fix${i}.txt`, content: String(i) }, `fix${i}`),
      );
    }
    const { agent } = implement(root, script);
    const result = await runAgentStream(agent, input, { ...streamOpts, maxRepeatedToolCalls: 8 });
    expect(result.stopped).toBeUndefined();
  });

  test("re-running the same command with no progress still stalls", async () => {
    const script: ScriptStep[] = Array.from(
      { length: 12 },
      (_, i) => () => toolCall("execute", { command: "echo test-run" }, `run${i}`),
    );
    const { agent } = implement(repo(), script);
    const result = await runAgentStream(agent, input, { ...streamOpts, maxRepeatedToolCalls: 8 });
    expect(result.stopped).toBe("stalled");
  });
});

describe("usage reporting", () => {
  test("counts subagent model calls with no budget configured", async () => {
    const { agent, model } = implement(repo(), [
      () => toolCall("task", { description: "go", subagent_type: "general-purpose" }, "t"),
      () => toolCall("ls", { path: "/" }, "l"),
    ]);
    const result = await runAgentStream(agent, input, streamOpts);
    expect(result.tokens.input).toBe(model.seenTools.length * 100);
    expect(model.seenTools.length).toBeGreaterThan(2);
  });
});

describe("shell lifecycle", () => {
  test("stopping the run lets the caller kill a command still running", async () => {
    const root = repo();
    const runner = new LocalShellRunner({
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      timeoutSeconds: 30,
      maxOutputBytes: 10_000,
    });
    const { agent } = implement(
      root,
      [
        () =>
          toolCall(
            "execute",
            {
              command: `node -e "setTimeout(()=>require('fs').writeFileSync('late.txt','x'),1500)"`,
            },
            "slow",
          ),
      ],
      { shellRunner: runner },
    );
    const result = await runAgentStream(agent, input, { ...streamOpts, maxRuntimeMs: 300 });
    await runner.terminateAll();
    expect(result.stopped).toBe("timeout");
    await Bun.sleep(1_800);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  });
});

describe("repository guidance", () => {
  test("is loaded from a trusted checkout and ignored for an untrusted fork head", async () => {
    const promptFor = async (trustRepoGuidance: boolean) => {
      const model = new ScriptedModel([]);
      const agent = buildAgent({
        ...common(repo(), model),
        mode: "implement",
        trustRepoGuidance,
      });
      await runAgentStream(agent, input, streamOpts);
      return model.seenPrompts[0] ?? "";
    };
    expect(await promptFor(true)).toContain("GUIDANCE_SENTINEL");
    expect(await promptFor(false)).not.toContain("GUIDANCE_SENTINEL");
  });
});

describe("review mode", () => {
  test("has no way to write and returns a typed review", async () => {
    const root = repo();
    const model = new ScriptedModel([
      submitReview({
        summary: "one issue",
        findings: [{ path: "a.txt", line: 1, body: "typo", severity: "warning" }],
      }),
    ]);
    const agent = buildAgent({ ...common(root, model), mode: "review" });
    const result = await runAgentStream(agent, input, streamOpts);

    for (const banned of ["write_file", "edit_file", "delete", "execute"]) {
      expect(model.seenTools[0]).not.toContain(banned);
    }
    expect(result.structuredResponse).toEqual({
      summary: "one issue",
      findings: [{ path: "a.txt", line: 1, body: "typo", severity: "warning" }],
    });
    expect(gitStatus(root)).toBe("");
  });

  test("a finding with no usable line is sent back to the model, not silently dropped", async () => {
    const root = repo();
    const model = new ScriptedModel([
      submitReview({ summary: "file-level", findings: [{ path: "a.txt", line: 0, body: "x" }] }),
      submitReview({ summary: "fixed", findings: [{ path: "a.txt", line: 1, body: "x" }] }),
    ]);
    const agent = buildAgent({ ...common(root, model), mode: "review" });
    const result = await runAgentStream(agent, input, streamOpts);
    expect(result.structuredResponse).toEqual({
      summary: "fixed",
      findings: [{ path: "a.txt", line: 1, body: "x" }],
    });
  });

  test("its delegated subagent stays read-only too", async () => {
    const root = repo();
    let subagentTools: string[] = [];
    const model = new ScriptedModel([
      () => toolCall("task", { description: "go", subagent_type: "general-purpose" }, "t"),
      (tools) => {
        subagentTools = tools;
        return toolCall("write_file", { file_path: "/gp.md", content: "x" }, "w");
      },
      () => toolCall("ls", { path: "/" }, "after"),
    ]);
    const agent = buildAgent({ ...common(root, model), mode: "review" });
    await runAgentStream(agent, input, { ...streamOpts, recursionLimit: 25 }).catch(() => {});
    expect(subagentTools).not.toContain("write_file");
    expect(subagentTools).not.toContain("execute");
    expect(existsSync(join(root, "gp.md"))).toBe(false);
  });
});

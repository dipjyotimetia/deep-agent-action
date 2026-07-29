import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { LocalShellBackend } from "deepagents";
import { FakeToolCallingModel } from "langchain";
import { buildShellEnv } from "../src/agent/env.js";
import { buildAgent } from "../src/agent/createAgent.js";
import type { ToolCallRecord } from "../src/types.js";

/**
 * Regression guard for the workspace sandboxing that `buildAgent` relies on.
 *
 * `buildAgent` constructs `LocalShellBackend` with `virtualMode: true` so the
 * built-in filesystem tools (ls/glob/grep/read/edit) cannot escape the repo
 * checkout. The motivating bug: in the default (virtualMode=false) mode an
 * exploratory model globbed outside the workspace, fast-glob recursed into an
 * unreadable `/home/packer` on the GitHub runner image, and — because
 * deepagents does not catch fast-glob errors — the EACCES rejection crashed the
 * entire run. This test pins the option values that prevent that.
 */
describe("buildAgent filesystem sandbox (virtualMode)", () => {
  // Mirrors the LocalShellBackend options used in createAgent.ts:buildAgent.
  function makeBackend(rootDir: string) {
    return new LocalShellBackend({
      rootDir,
      virtualMode: true,
      env: buildShellEnv(),
      timeout: 5,
      maxOutputBytes: 200_000,
    });
  }

  let root: string;
  let backend: LocalShellBackend;

  // Create a fresh tree per test.
  function setup(): void {
    root = mkdtempSync(join(tmpdir(), "da-sandbox-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
    backend = makeBackend(root);
  }

  test("ls of an outside-root absolute path returns nothing (no escape, no throw)", async () => {
    setup();
    // "/etc" is real and outside the workspace root; in virtual mode it must
    // resolve under rootDir (where it does not exist) → empty, not the real /etc.
    const result = await backend.ls("/etc");
    expect(result.files ?? []).toEqual([]);
  });

  test("glob rooted outside the workspace returns nothing instead of throwing", async () => {
    setup();
    // A recursive glob at "/" must be contained to rootDir, never reaching the
    // real filesystem root (where unreadable dirs would crash fast-glob).
    const result = await backend.glob("**/*", "/");
    const paths = (result.files ?? []).map((f) => f.path);
    // Everything returned is inside the virtual workspace tree.
    for (const p of paths) expect(p.startsWith("..")).toBe(false);
    expect(paths.some((p) => p.includes("a.ts"))).toBe(true);
  });

  test("repo files remain readable via virtual absolute paths", async () => {
    setup();
    const result = await backend.read("/src/a.ts");
    // deepagents returns { content, ... } on success.
    const content = (result as { content?: string }).content ?? "";
    expect(content).toContain("export const x = 1");
  });

  test("built-in filesystem tools cannot write repository deepagents guidance", async () => {
    const guardedRoot = mkdtempSync(join(tmpdir(), "da-policy-"));
    mkdirSync(join(guardedRoot, ".deepagents"), { recursive: true });
    writeFileSync(join(guardedRoot, ".deepagents", "AGENTS.md"), "original\n");

    const agent = buildAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "write_file",
              args: {
                file_path: "/.deepagents/AGENTS.md",
                content: "tampered\n",
              },
              id: "write-memory",
            },
          ],
        ],
      }),
      rootDir: guardedRoot,
      mode: "implement",
      systemPrompt: "test",
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
    });

    const result = await agent.invoke({
      messages: [{ role: "user", content: "rewrite the guidance" }],
    });
    const writeResult = result.messages.find(
      (message): message is ToolMessage =>
        message instanceof ToolMessage && message.name === "write_file",
    );
    expect(writeResult?.status).toBe("error");
    expect(writeResult?.content).toContain("permission denied for write on /.deepagents/AGENTS.md");
    expect(readFileSync(join(guardedRoot, ".deepagents", "AGENTS.md"), "utf8")).toBe("original\n");
  });

  test("a relative write path is recoverable so the agent can retry with an absolute path", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "da-relative-path-"));
    mkdirSync(join(rootDir, "demo"), { recursive: true });
    const agent = buildAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "write_file",
              args: {
                file_path: "demo/E2E_HELLO.md",
                content: "Hello from E2E.\n",
              },
              id: "relative-write",
            },
          ],
          [
            {
              name: "write_file",
              args: {
                file_path: "/demo/E2E_HELLO.md",
                content: "Hello from E2E.\n",
              },
              id: "absolute-retry",
            },
          ],
          [],
        ],
      }),
      rootDir,
      mode: "implement",
      systemPrompt: "Create the requested file and correct recoverable tool errors.",
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
    });

    const result = await agent.invoke({
      messages: [
        {
          role: "user",
          content:
            "Create demo/E2E_HELLO.md containing a single short greeting line. Do not modify any other files.",
        },
      ],
    });
    const relativePathError = result.messages.find(
      (message): message is ToolMessage =>
        message instanceof ToolMessage && message.tool_call_id === "relative-write",
    );

    expect(relativePathError?.status).toBe("error");
    expect(relativePathError?.content).toContain('path must be absolute: "demo/E2E_HELLO.md"');
    expect(readFileSync(join(rootDir, "demo", "E2E_HELLO.md"), "utf8")).toBe("Hello from E2E.\n");
  });

  test("review mode writes only to isolated output and exposes no edit or execute capability", async () => {
    const reviewRoot = mkdtempSync(join(tmpdir(), "da-review-root-"));
    const reviewOutputDir = mkdtempSync(join(tmpdir(), "da-review-output-"));
    mkdirSync(join(reviewRoot, "src"), { recursive: true });
    writeFileSync(join(reviewRoot, "src", "a.ts"), "original\n");
    const toolCallRecord: ToolCallRecord[] = [];

    const agent = buildAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "write_file",
              args: {
                file_path: "/review-output/findings.json",
                content: '{"summary":"done","findings":[]}',
              },
              id: "write-findings",
            },
          ],
          [
            {
              name: "write_file",
              args: { file_path: "/src/a.ts", content: "tampered\n" },
              id: "write-repo",
            },
          ],
          [
            {
              name: "edit_file",
              args: {
                file_path: "/src/a.ts",
                old_string: "original",
                new_string: "tampered",
              },
              id: "edit-repo",
            },
          ],
          [
            {
              name: "execute",
              args: { command: "touch review-bypass-marker" },
              id: "execute-repo",
            },
          ],
          [],
        ],
      }),
      rootDir: reviewRoot,
      mode: "review",
      reviewOutputDir,
      systemPrompt: "Write the review output without changing the repository.",
      allowedCommands: ["touch"],
      deniedCommands: [],
      filesystemPermissions: [{ operations: ["write"], paths: ["/**"], mode: "allow" }],
      shellTimeoutSeconds: 5,
      toolCallRecord,
    });

    await agent.invoke({ messages: [{ role: "user", content: "Review this change." }] });

    expect(readFileSync(join(reviewOutputDir, "findings.json"), "utf8")).toBe(
      '{"summary":"done","findings":[]}',
    );
    expect(readFileSync(join(reviewRoot, "src", "a.ts"), "utf8")).toBe("original\n");
    expect(existsSync(join(reviewRoot, "review-bypass-marker"))).toBe(false);
    expect(toolCallRecord).toEqual([]);
  });

  test("delegated review subagents cannot regain shell execution", async () => {
    const reviewRoot = mkdtempSync(join(tmpdir(), "da-review-subagent-"));
    const reviewOutputDir = mkdtempSync(join(tmpdir(), "da-review-output-"));
    const toolCallRecord: ToolCallRecord[] = [];
    const agent = buildAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              name: "task",
              args: {
                description: "Run touch delegated-review-bypass.",
                subagent_type: "general-purpose",
              },
              id: "delegate-review",
            },
          ],
          [
            {
              name: "execute",
              args: { command: "touch delegated-review-bypass" },
              id: "delegated-execute",
            },
          ],
          [],
          [],
        ],
      }),
      rootDir: reviewRoot,
      mode: "review",
      reviewOutputDir,
      systemPrompt: "Review without changing the repository.",
      allowedCommands: ["touch"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord,
    });

    await agent.invoke({ messages: [{ role: "user", content: "Delegate this review." }] });

    expect(existsSync(join(reviewRoot, "delegated-review-bypass"))).toBe(false);
    expect(toolCallRecord).toEqual([]);
  });
});

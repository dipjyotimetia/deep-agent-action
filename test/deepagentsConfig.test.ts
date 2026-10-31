import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { ChatOpenAI } from "@langchain/openai";
import { ChatBedrockConverse } from "@langchain/aws";
import { ChatVertexAI } from "@langchain/google-vertexai";
import { getHarnessProfile } from "deepagents";
import {
  buildFilesystemPermissions,
  discoverDeepAgentSources,
  parseFilesystemPermissions,
  parseHarnessProfile,
} from "../src/agent/policy.js";
import { buildAgent, resolveAgentPolicy } from "../src/agent/createAgent.js";

describe("deepagents policy parsing", () => {
  test("parses a validated harness profile and rejects unknown keys", () => {
    const profile = parseHarnessProfile(
      JSON.stringify({
        systemPromptSuffix: "Keep edits small.",
        excludedTools: ["execute"],
      }),
      "harness_profile",
    );

    expect(profile?.systemPromptSuffix).toBe("Keep edits small.");
    expect([...profile!.excludedTools]).toEqual(["execute"]);
    expect(() => parseHarnessProfile('{"typo":true}', "harness_profile")).toThrow(
      "harness_profile",
    );
    expect(() =>
      parseHarnessProfile('{"excludedMiddleware":["ShellGuardMiddleware"]}', "harness_profile"),
    ).toThrow("ShellGuardMiddleware");
  });

  test("parses filesystem permissions and rejects unsafe paths", () => {
    expect(
      parseFilesystemPermissions(
        JSON.stringify([
          { operations: ["read"], paths: ["/src/**"] },
          { operations: ["write"], paths: ["/generated/**"], mode: "deny" },
        ]),
        "filesystem_permissions",
      ),
    ).toEqual([
      { operations: ["read"], paths: ["/src/**"] },
      { operations: ["write"], paths: ["/generated/**"], mode: "deny" },
    ]);

    expect(() =>
      parseFilesystemPermissions(
        JSON.stringify([{ operations: ["write"], paths: ["../secrets/**"] }]),
        "filesystem_permissions",
      ),
    ).toThrow("filesystem_permissions");
  });
});

describe("deepagents policy defaults", () => {
  test("discovers only repository-local memory and skills", () => {
    const root = mkdtempSync(join(tmpdir(), "deep-agent-policy-"));
    mkdirSync(join(root, ".deepagents", "skills"), { recursive: true });
    writeFileSync(join(root, ".deepagents", "AGENTS.md"), "Use the repo test command.");

    expect(discoverDeepAgentSources(root)).toEqual({
      memory: ["/.deepagents/AGENTS.md"],
      skills: ["/.deepagents/skills/"],
    });
  });

  test("keeps the memory directory write-protected before custom rules", () => {
    const permissions = buildFilesystemPermissions([
      { operations: ["write"], paths: ["/**"], mode: "allow" },
    ]);

    expect(permissions[0]).toEqual({
      operations: ["write"],
      paths: ["/.deepagents/**"],
      mode: "deny",
    });
    expect(permissions[1]).toEqual({
      operations: ["read", "write"],
      paths: ["/.git", "/.git/**"],
      mode: "deny",
    });
    expect(permissions.at(-1)).toEqual({
      operations: ["write"],
      paths: ["/**"],
      mode: "allow",
    });
  });

  test("assembles the discovered sources and policy for the agent", () => {
    const root = mkdtempSync(join(tmpdir(), "deep-agent-policy-"));
    mkdirSync(join(root, ".deepagents", "skills"), { recursive: true });
    writeFileSync(join(root, ".deepagents", "AGENTS.md"), "Read-only guidance.");

    const policy = resolveAgentPolicy({
      rootDir: root,
      filesystemPermissions: [{ operations: ["read"], paths: ["/src/**"] }],
    });

    expect(policy.memory).toEqual(["/.deepagents/AGENTS.md"]);
    expect(policy.skills).toEqual(["/.deepagents/skills/"]);
    expect(policy.permissions[0]?.mode).toBe("deny");
  });

  test("registers a profile under the concrete ChatOpenAI alias", () => {
    const root = mkdtempSync(join(tmpdir(), "deep-agent-profile-"));
    const profile = parseHarnessProfile('{"systemPromptSuffix":"profile applied"}')!;

    // OpenRouter and openai-compatible providers are represented by ChatOpenAI
    // instances, so buildAgent must register both provider keys.
    buildAgent({
      model: new ChatOpenAI({ model: "test-model", apiKey: "test" }),
      modelSpec: "openrouter:test-model",
      rootDir: root,
      mode: "implement",
      systemPrompt: "test",
      harnessProfile: profile,
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
    });

    expect(getHarnessProfile("openai")?.systemPromptSuffix).toBe("profile applied");
  });

  test("assembles configured specialist subagents with a static provider model override", () => {
    const root = mkdtempSync(join(tmpdir(), "deep-agent-subagent-"));
    let requestedModel = "";

    buildAgent({
      model: fakeModel().respond(new AIMessage("main")),
      rootDir: root,
      mode: "implement",
      systemPrompt: "test",
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
      subagents: [
        {
          name: "release-reviewer",
          description: "Reviews release readiness.",
          systemPrompt: "Report concise findings only.",
          mcpTools: [],
          model: "openai:gpt-5",
          responseMode: "findings",
        },
      ],
      subagentModelFor: (model) => {
        requestedModel = model;
        return fakeModel().respond(new AIMessage("specialist"));
      },
    });

    expect(requestedModel).toBe("openai:gpt-5");
  });

  test("does not activate specialists in read-only review mode", () => {
    expect(() =>
      buildAgent({
        model: fakeModel().respond(new AIMessage("review")),
        rootDir: mkdtempSync(join(tmpdir(), "deep-agent-review-subagent-")),
        mode: "review",
        systemPrompt: "test",
        allowedCommands: ["echo"],
        deniedCommands: [],
        shellTimeoutSeconds: 5,
        toolCallRecord: [],
        subagents: [
          {
            name: "release-reviewer",
            description: "Reviews release readiness.",
            systemPrompt: "Report concise findings only.",
            mcpTools: ["publish_release"],
            model: "openai:gpt-5",
          },
        ],
        subagentModelFor: () => {
          throw new Error("review mode must not build specialists");
        },
      }),
    ).not.toThrow();
  });

  test("loads repository memory and skill metadata through the assembled agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "deep-agent-memory-"));
    mkdirSync(join(root, ".deepagents", "skills", "release"), { recursive: true });
    writeFileSync(join(root, ".deepagents", "AGENTS.md"), "MEMORY_SENTINEL");
    writeFileSync(
      join(root, ".deepagents", "skills", "release", "SKILL.md"),
      "---\nname: release\ndescription: publish releases\n---\nSKILL_SENTINEL",
    );

    const model = fakeModel().respond(new AIMessage("done"));
    const agent = buildAgent({
      model,
      rootDir: root,
      mode: "implement",
      systemPrompt: "SYSTEM_SENTINEL",
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
    });

    await agent.invoke({ messages: [{ role: "user", content: "hello" }] });
    const systemMessage = model.calls[0]?.messages.find(
      (message) => message.getType() === "system",
    );
    const systemContent = JSON.stringify(systemMessage?.content);
    expect(systemContent).toContain("MEMORY_SENTINEL");
    expect(systemContent).toContain("release");
    expect(systemContent).toContain("/.deepagents/skills/release/SKILL.md");
  });

  test("keeps profiles addressable for Bedrock and Vertex model adapters", () => {
    const profile = parseHarnessProfile('{"systemPromptSuffix":"provider profile"}')!;
    const bedrock = new ChatBedrockConverse({
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      region: "us-east-1",
    });
    const vertex = new ChatVertexAI({ model: "gemini-2.5-pro", location: "us-central1" });

    buildAgent({
      model: bedrock,
      modelSpec: "bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0",
      rootDir: process.cwd(),
      mode: "implement",
      systemPrompt: "test",
      harnessProfile: profile,
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
    });
    buildAgent({
      model: vertex,
      modelSpec: "vertexai:gemini-2.5-pro",
      rootDir: process.cwd(),
      mode: "implement",
      systemPrompt: "test",
      harnessProfile: profile,
      allowedCommands: ["echo"],
      deniedCommands: [],
      shellTimeoutSeconds: 5,
      toolCallRecord: [],
    });

    expect((bedrock as unknown as { model_name?: string }).model_name).toBe(
      "bedrock:anthropic.claude-3-5-sonnet-20241022-v2_0",
    );
    expect((vertex as unknown as { model_name?: string }).model_name).toBe(
      "vertexai:gemini-2.5-pro",
    );
    expect(
      getHarnessProfile("bedrock:anthropic.claude-3-5-sonnet-20241022-v2_0")?.systemPromptSuffix,
    ).toBe("provider profile");
    expect(getHarnessProfile("vertexai:gemini-2.5-pro")?.systemPromptSuffix).toBe(
      "provider profile",
    );
  });
});

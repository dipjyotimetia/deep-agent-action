import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  parseSubagents,
  resolveSubagents,
  type DeepAgentSubagentConfig,
} from "../src/agent/subagents.js";
import { buildFilesystemPermissions, PERMISSION_FLOOR } from "../src/agent/policy.js";

const releaseTool = new DynamicStructuredTool({
  name: "publish_release",
  description: "Publish a release.",
  schema: z.object({ tag: z.string() }),
  func: async () => "published",
});

const base: DeepAgentSubagentConfig = {
  name: "release-reviewer",
  description: "Reviews release readiness.",
  systemPrompt: "Review releases and report concise findings.",
  mcpTools: ["publish_release"],
};

describe("deepagents specialist subagents", () => {
  test("parses a strict declarative subagent configuration", () => {
    expect(
      parseSubagents(
        JSON.stringify([
          {
            name: "release-reviewer",
            description: "Reviews release readiness.",
            system_prompt: "Review releases and report concise findings.",
            mcp_tools: ["publish_release"],
            skills: ["/.deepagents/skills/release/"],
            filesystem_permissions: [
              { operations: ["write"], paths: ["/generated/**"], mode: "deny" },
            ],
            response_mode: "findings",
          },
        ]),
      ),
    ).toEqual([
      {
        ...base,
        mcpTools: ["publish_release"],
        skills: ["/.deepagents/skills/release/"],
        filesystemPermissions: [{ operations: ["write"], paths: ["/generated/**"], mode: "deny" }],
        responseMode: "findings",
      },
    ]);
  });

  test("requires an explicit MCP tool allow-list", () => {
    const { mcpTools: _mcpTools, ...withoutTools } = base;
    expect(() => parseSubagents(JSON.stringify([withoutTools]))).toThrow("mcpTools");
  });

  test("rejects reserved names and any configuration that can broaden filesystem access", () => {
    expect(() => parseSubagents(JSON.stringify([{ ...base, name: "general-purpose" }]))).toThrow(
      "general-purpose",
    );
    expect(() =>
      parseSubagents(
        JSON.stringify([
          {
            ...base,
            filesystem_permissions: [{ operations: ["write"], paths: ["/**"], mode: "allow" }],
          },
        ]),
      ),
    ).toThrow("deny");
  });

  test("rejects duplicate names, unknown fields, and skill paths outside repository guidance", () => {
    expect(() => parseSubagents(JSON.stringify([base, base]))).toThrow("unique");
    expect(() => parseSubagents(JSON.stringify([{ ...base, unexpected: true }]))).toThrow(
      "subagents",
    );
    expect(() => parseSubagents(JSON.stringify([{ ...base, skills: ["/tmp/unsafe/"] }]))).toThrow(
      "/.deepagents/skills/",
    );
    expect(() =>
      parseSubagents(
        JSON.stringify([{ ...base, mcpTools: ["publish_release", "publish_release"] }]),
      ),
    ).toThrow("duplicates");
  });

  test("resolves only configured MCP tools and preserves the security floor", () => {
    const resolved = resolveSubagents(
      [
        {
          ...base,
          mcpTools: ["publish_release"],
          filesystemPermissions: [
            { operations: ["write"], paths: ["/generated/**"], mode: "deny" },
          ],
          responseMode: "findings",
        },
      ],
      [releaseTool],
      buildFilesystemPermissions([{ operations: ["read"], paths: ["/src/**"] }]),
      ["/.deepagents/skills/"],
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.tools?.map((tool) => tool.name)).toEqual(["publish_release"]);
    expect(resolved[0]?.permissions).toEqual([
      ...PERMISSION_FLOOR,
      { operations: ["write"], paths: ["/generated/**"], mode: "deny" },
      { operations: ["read"], paths: ["/src/**"] },
    ]);
    expect(resolved[0]?.skills).toEqual(["/.deepagents/skills/"]);
    expect(resolved[0]?.responseFormat).toBeDefined();
  });

  test("fails closed when a configured MCP tool is unavailable", () => {
    expect(() =>
      resolveSubagents([{ ...base, mcpTools: ["missing_tool"] }], [releaseTool], [], []),
    ).toThrow("missing_tool");
  });
});

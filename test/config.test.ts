import { describe, expect, test } from "bun:test";
import {
  loadConfig,
  normalizeModel,
  parseList,
  parseBool,
  parsePositiveNumber,
  parsePositiveInteger,
  parseShellSandbox,
} from "../src/config.js";
import { DEFAULT_TRIAGE_LABELS } from "../src/modes/triage.js";

describe("normalizeModel", () => {
  test("prefixes a bare claude model with anthropic", () => {
    const m = normalizeModel("claude-sonnet-4-5");
    expect(m).toEqual({
      provider: "anthropic",
      name: "claude-sonnet-4-5",
      full: "anthropic:claude-sonnet-4-5",
    });
  });

  test("infers provider from a bare model-name prefix", () => {
    expect(normalizeModel("gpt-5").provider).toBe("openai");
    expect(normalizeModel("o3-mini").provider).toBe("openai");
    expect(normalizeModel("gemini-2.5-pro").provider).toBe("google");
    expect(normalizeModel("mistral-large").provider).toBe("anthropic"); // unknown → default
  });

  test("respects an explicit provider prefix", () => {
    expect(normalizeModel("openai:gpt-5")).toEqual({
      provider: "openai",
      name: "gpt-5",
      full: "openai:gpt-5",
    });
    expect(normalizeModel("openrouter:openai/gpt-4o").name).toBe("openai/gpt-4o");
  });

  test("splits only on the first colon (Bedrock model ids contain colons)", () => {
    const m = normalizeModel("bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(m.provider).toBe("bedrock");
    expect(m.name).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
  });

  test("lower-cases the provider", () => {
    expect(normalizeModel("Anthropic:claude").provider).toBe("anthropic");
  });
});

describe("parseList", () => {
  test("splits on commas and newlines, trims, dedupes", () => {
    expect(parseList("git, npm\npytest, git")).toEqual(["git", "npm", "pytest"]);
  });
  test("returns empty for undefined", () => {
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("loadConfig model default", () => {
  test("defaults to Claude Sonnet 5", () => {
    delete process.env.INPUT_MODEL;
    expect(loadConfig().model).toBe("anthropic:claude-sonnet-5");
  });
});

describe("parseBool", () => {
  test("is true only for truthy strings", () => {
    expect(parseBool("true")).toBe(true);
    expect(parseBool("TRUE")).toBe(true);
    expect(parseBool("1")).toBe(true);
    expect(parseBool("false")).toBe(false);
    expect(parseBool("")).toBe(false);
    expect(parseBool(undefined)).toBe(false);
  });
});

describe("parsePositiveNumber", () => {
  test("returns undefined when unset or blank", () => {
    expect(parsePositiveNumber(undefined, "x")).toBeUndefined();
    expect(parsePositiveNumber("", "x")).toBeUndefined();
    expect(parsePositiveNumber("   ", "x")).toBeUndefined();
  });

  test("parses a valid positive number", () => {
    expect(parsePositiveNumber("5", "x")).toBe(5);
    expect(parsePositiveNumber("0.25", "x")).toBe(0.25);
    expect(parsePositiveNumber(" 200000 ", "x")).toBe(200000);
  });

  test("throws on a malformed value (fails closed, not open)", () => {
    expect(() => parsePositiveNumber("$5", "max_cost_usd")).toThrow("max_cost_usd");
    expect(() => parsePositiveNumber("abc", "x")).toThrow();
    expect(() => parsePositiveNumber("0", "x")).toThrow();
    expect(() => parsePositiveNumber("-3", "x")).toThrow();
  });
});

describe("parsePositiveInteger", () => {
  test("returns undefined when unset", () => {
    expect(parsePositiveInteger(undefined, "recursion_limit")).toBeUndefined();
    expect(parsePositiveInteger("", "recursion_limit")).toBeUndefined();
  });

  test("parses a valid positive integer", () => {
    expect(parsePositiveInteger("150", "recursion_limit")).toBe(150);
    expect(parsePositiveInteger(" 42 ", "recursion_limit")).toBe(42);
  });

  test("throws on fractional, zero, negative, or malformed values", () => {
    expect(() => parsePositiveInteger("1.5", "recursion_limit")).toThrow("recursion_limit");
    expect(() => parsePositiveInteger("0", "recursion_limit")).toThrow();
    expect(() => parsePositiveInteger("-2", "recursion_limit")).toThrow();
    expect(() => parsePositiveInteger("many", "recursion_limit")).toThrow();
  });
});

describe("loadConfig recursion limit", () => {
  test("defaults to 150 and honors INPUT_RECURSION_LIMIT", () => {
    delete process.env.INPUT_RECURSION_LIMIT;
    expect(loadConfig().recursionLimit).toBe(150);
    process.env.INPUT_RECURSION_LIMIT = "400";
    try {
      expect(loadConfig().recursionLimit).toBe(400);
    } finally {
      delete process.env.INPUT_RECURSION_LIMIT;
    }
  });
});

describe("loadConfig v2 landing defaults", () => {
  test("approval-gates landing and keeps the immutable protected-path floor", () => {
    delete process.env.INPUT_REQUIRE_PUSH_APPROVAL;
    delete process.env.INPUT_PROTECTED_PATHS;
    const config = loadConfig();
    expect(config.requirePushApproval).toBe(true);
    expect(config.protectedPaths).toContain(".deepagents/**");

    process.env.INPUT_REQUIRE_PUSH_APPROVAL = "false";
    process.env.INPUT_PROTECTED_PATHS = ".github/workflows/**";
    try {
      const configured = loadConfig();
      expect(configured.requirePushApproval).toBe(false);
      expect(configured.protectedPaths).toContain(".github/workflows/**");
      expect(configured.protectedPaths).toContain(".deepagents/**");
    } finally {
      delete process.env.INPUT_REQUIRE_PUSH_APPROVAL;
      delete process.env.INPUT_PROTECTED_PATHS;
    }
  });
});

describe("loadConfig repeated tool-call limit", () => {
  test("defaults to 8, honors an override, and rejects invalid values", () => {
    delete process.env.INPUT_MAX_REPEATED_TOOL_CALLS;
    expect(loadConfig().maxRepeatedToolCalls).toBe(8);
    process.env.INPUT_MAX_REPEATED_TOOL_CALLS = "12";
    expect(loadConfig().maxRepeatedToolCalls).toBe(12);
    process.env.INPUT_MAX_REPEATED_TOOL_CALLS = "0";
    expect(() => loadConfig()).toThrow("max_repeated_tool_calls");
    delete process.env.INPUT_MAX_REPEATED_TOOL_CALLS;
  });
});

describe("loadConfig triage lifecycle", () => {
  test("uses the visible lifecycle defaults and validates its bounded retry limit", () => {
    delete process.env.INPUT_TRIAGE_LABEL_NEEDS_REPRODUCTION;
    delete process.env.INPUT_TRIAGE_MAX_FAILED_ATTEMPTS;
    expect(loadConfig().triageLabels.needsReproduction).toBe(
      DEFAULT_TRIAGE_LABELS.needsReproduction,
    );
    expect(loadConfig().triageMaxFailedAttempts).toBe(3);

    process.env.INPUT_TRIAGE_LABEL_NEEDS_REPRODUCTION = "state: more info";
    process.env.INPUT_TRIAGE_MAX_FAILED_ATTEMPTS = "4";
    try {
      const config = loadConfig();
      expect(config.triageLabels.needsReproduction).toBe("state: more info");
      expect(config.triageMaxFailedAttempts).toBe(4);
    } finally {
      delete process.env.INPUT_TRIAGE_LABEL_NEEDS_REPRODUCTION;
      delete process.env.INPUT_TRIAGE_MAX_FAILED_ATTEMPTS;
    }
  });
});

describe("loadConfig runner timing inputs", () => {
  test("rejects non-positive or fractional shell timeouts and comment debounce values", () => {
    process.env.INPUT_SHELL_TIMEOUT_SECONDS = "-1";
    expect(() => loadConfig()).toThrow("shell_timeout_seconds");
    delete process.env.INPUT_SHELL_TIMEOUT_SECONDS;

    process.env.INPUT_COMMENT_DEBOUNCE_MS = "1.5";
    try {
      expect(() => loadConfig()).toThrow("comment_debounce_ms");
    } finally {
      delete process.env.INPUT_COMMENT_DEBOUNCE_MS;
    }
  });
});

describe("loadConfig deepagents policy", () => {
  test("loads strict profile and permission JSON inputs", () => {
    process.env.INPUT_HARNESS_PROFILE = JSON.stringify({
      systemPromptSuffix: "Use the repository conventions.",
    });
    process.env.INPUT_FILESYSTEM_PERMISSIONS = JSON.stringify([
      { operations: ["read"], paths: ["/src/**"] },
    ]);

    try {
      const config = loadConfig();
      expect(config.harnessProfile?.systemPromptSuffix).toBe("Use the repository conventions.");
      expect(config.filesystemPermissions).toEqual([{ operations: ["read"], paths: ["/src/**"] }]);
    } finally {
      delete process.env.INPUT_HARNESS_PROFILE;
      delete process.env.INPUT_FILESYSTEM_PERMISSIONS;
    }
  });

  test("loads strict specialist subagent JSON", () => {
    process.env.INPUT_SUBAGENTS = JSON.stringify([
      {
        name: "release-reviewer",
        description: "Reviews releases.",
        systemPrompt: "Report concise findings.",
        mcpTools: ["publish_release"],
        responseMode: "findings",
      },
    ]);

    try {
      expect(loadConfig().subagents).toEqual([
        {
          name: "release-reviewer",
          description: "Reviews releases.",
          systemPrompt: "Report concise findings.",
          mcpTools: ["publish_release"],
          responseMode: "findings",
        },
      ]);
    } finally {
      delete process.env.INPUT_SUBAGENTS;
    }
  });
});

describe("parseShellSandbox", () => {
  test("defaults to auto, with no shell network and MCP network available", () => {
    expect(parseShellSandbox({})).toEqual({
      shellSandbox: "auto",
      shellSandboxImage: undefined,
      shellSandboxNetwork: "none",
      mcpSandboxNetwork: "bridge",
    });
  });

  test("setting an image is enough to turn the sandbox on", () => {
    expect(parseShellSandbox({ image: "node:22@sha256:abc" }).shellSandbox).toBe("docker");
    expect(parseShellSandbox({ mode: "auto", image: "node:22" }).shellSandbox).toBe("docker");
  });

  test("an explicit none wins over an image", () => {
    expect(parseShellSandbox({ mode: "none", image: "node:22" }).shellSandbox).toBe("none");
  });

  test("accepts a full docker configuration", () => {
    expect(
      parseShellSandbox({
        mode: "docker",
        image: "node:22@sha256:abc",
        network: "bridge",
        mcpNetwork: "none",
      }),
    ).toEqual({
      shellSandbox: "docker",
      shellSandboxImage: "node:22@sha256:abc",
      shellSandboxNetwork: "bridge",
      mcpSandboxNetwork: "none",
    });
  });

  test("fails loudly rather than silently running unsandboxed", () => {
    expect(() => parseShellSandbox({ mode: "dockr" })).toThrow("shell_sandbox");
    expect(() => parseShellSandbox({ mode: "docker" })).toThrow("shell_sandbox_image");
    expect(() => parseShellSandbox({ image: "a", network: "host" })).toThrow(
      "shell_sandbox_network",
    );
    expect(() => parseShellSandbox({ image: "a", mcpNetwork: "host" })).toThrow(
      "mcp_sandbox_network",
    );
  });

  test("rejects an image reference that could be read as a docker flag", () => {
    expect(() => parseShellSandbox({ mode: "docker", image: "--privileged" })).toThrow(
      "not a valid image",
    );
  });
});

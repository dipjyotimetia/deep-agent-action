import { describe, expect, test } from "bun:test";
import {
  assertPublishableChanges,
  DEFAULT_PROTECTED_PATHS,
  findProtectedPaths,
  parseProtectedPaths,
} from "../src/github/protectedPaths.js";
import { changedPathsFromPorcelain } from "../src/github/ops.js";

describe("protected landing paths", () => {
  test("always protects repository agent guidance and its configuration", () => {
    expect(DEFAULT_PROTECTED_PATHS).toEqual([
      ".deepagents/**",
      ".github/deep-agent.yml",
      ".github/deep-agent.yaml",
      ".deep-agent.yml",
      ".deep-agent.yaml",
      ".github/workflows/**",
    ]);
  });

  test("finds immutable and workflow-configured protected paths", () => {
    expect(
      findProtectedPaths(
        [
          "src/index.ts",
          ".deepagents/AGENTS.md",
          ".github/workflows/release.yml",
          ".github/deep-agent.yml",
        ],
        [...DEFAULT_PROTECTED_PATHS, "docs/internal/**"],
      ),
    ).toEqual([".deepagents/AGENTS.md", ".github/workflows/release.yml", ".github/deep-agent.yml"]);
  });

  test("accepts only normalized, repository-relative glob patterns", () => {
    expect(parseProtectedPaths(".github/workflows/**, .github/CODEOWNERS")).toEqual([
      ".github/workflows/**",
      ".github/CODEOWNERS",
    ]);
    expect(() => parseProtectedPaths("/etc/**")).toThrow("protected_paths");
    expect(() => parseProtectedPaths("../.deepagents/**")).toThrow("protected_paths");
  });

  test("checks both source and destination paths for a rename", () => {
    expect(changedPathsFromPorcelain("R  .deepagents/old.md -> src/new.md")).toEqual([
      ".deepagents/old.md",
      "src/new.md",
    ]);
  });

  test("uses NUL-delimited paths so Git display quoting cannot bypass the guard", () => {
    expect(
      changedPathsFromPorcelain(
        " M .deepagents/guide with spaces.md\0R  .deepagents/new name.md\0README old.md\0",
      ),
    ).toEqual([".deepagents/guide with spaces.md", ".deepagents/new name.md", "README old.md"]);
  });

  test("refuses a landing attempt that includes protected files", () => {
    expect(() =>
      assertPublishableChanges(["src/index.ts", ".deepagents/AGENTS.md"], DEFAULT_PROTECTED_PATHS),
    ).toThrow("Refusing to publish protected paths: .deepagents/AGENTS.md.");
  });
});

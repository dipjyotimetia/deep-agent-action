import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseHarnessProfileConfig,
  type FilesystemPermission,
  type HarnessProfile,
} from "deepagents";
import { z } from "zod";

/** Repository-local deepagents memory and skill locations. */
export const DEEPAGENTS_MEMORY_PATH = "/.deepagents/AGENTS.md";
export const DEEPAGENTS_SKILLS_PATH = "/.deepagents/skills/";

const permissionSchema = z
  .object({
    operations: z.array(z.enum(["read", "write"])).min(1),
    paths: z.array(z.string().min(1)).min(1),
    mode: z.enum(["allow", "deny"]).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    for (const path of rule.paths) {
      if (!path.startsWith("/") || path.includes("..") || path.includes("~")) {
        ctx.addIssue({
          code: "custom",
          path: ["paths"],
          message: "paths must be absolute glob patterns without '..' or '~'.",
        });
      }
    }
  });

function parseJson(raw: string | undefined, name: string): unknown | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${name} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Parse an optional deepagents harness profile from action-input JSON. */
export function parseHarnessProfile(
  raw: string | undefined,
  name = "harness_profile",
): HarnessProfile | undefined {
  const value = parseJson(raw, name);
  if (value === undefined) return undefined;
  return parseHarnessProfileValue(value, name);
}

/** Validate an already-parsed YAML/JSON harness profile value. */
export function parseHarnessProfileValue(value: unknown, name = "harness_profile"): HarnessProfile {
  try {
    const profile = parseHarnessProfileConfig(value);
    if (profile.excludedMiddleware.has("ShellGuardMiddleware")) {
      throw new Error(
        "ShellGuardMiddleware is a protected legacy name; command policy is enforced by the backend and cannot be excluded.",
      );
    }
    return profile;
  } catch (err) {
    throw new Error(`${name} is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Parse optional JSON filesystem permission rules. */
export function parseFilesystemPermissions(
  raw: string | undefined,
  name = "filesystem_permissions",
): FilesystemPermission[] | undefined {
  const value = parseJson(raw, name);
  if (value === undefined) return undefined;
  return parseFilesystemPermissionsValue(value, name);
}

/** Validate an already-parsed YAML/JSON filesystem permission value. */
export function parseFilesystemPermissionsValue(
  value: unknown,
  name = "filesystem_permissions",
): FilesystemPermission[] {
  const parsed = permissionSchema.array().safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name} is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Find existing repository-local deepagents sources without reading them. */
export function discoverDeepAgentSources(rootDir: string): {
  memory?: string[];
  skills?: string[];
} {
  const deepagentsDir = join(rootDir, ".deepagents");
  const memoryFile = join(deepagentsDir, "AGENTS.md");
  const skillsDir = join(deepagentsDir, "skills");
  const sources: { memory?: string[]; skills?: string[] } = {};

  if (isFile(memoryFile)) sources.memory = [DEEPAGENTS_MEMORY_PATH];
  if (isDirectory(skillsDir)) sources.skills = [DEEPAGENTS_SKILLS_PATH];
  return sources;
}

/**
 * Rules no custom permission can override. Deepagents evaluates rules in
 * declaration order, so these must precede user-provided permissions.
 *
 * - Repository memory and skills stay read-only.
 * - `.git` is out of reach entirely: its config decides which programs the
 *   control plane's own Git commands run and where its token is sent.
 */
export const PERMISSION_FLOOR: readonly FilesystemPermission[] = [
  { operations: ["write"], paths: ["/.deepagents/**"], mode: "deny" },
  { operations: ["read", "write"], paths: ["/.git", "/.git/**"], mode: "deny" },
];

/** Apply the immutable floor ahead of workflow-configured rules. */
export function buildFilesystemPermissions(
  custom?: FilesystemPermission[],
): FilesystemPermission[] {
  return [...PERMISSION_FLOOR, ...(custom ?? [])];
}

/**
 * Review agents write nothing. The catch-all deny precedes repository policy
 * because review mode must remain non-mutating even when a repository normally
 * allows broad writes.
 */
export function buildReviewFilesystemPermissions(
  custom?: FilesystemPermission[],
): FilesystemPermission[] {
  return [
    ...PERMISSION_FLOOR,
    { operations: ["write"], paths: ["/**"], mode: "deny" },
    ...(custom ?? []),
  ];
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return existsSync(path);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

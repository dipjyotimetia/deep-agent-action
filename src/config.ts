import * as core from "@actions/core";
import type { Config } from "./types.js";
import { parseFilesystemPermissions, parseHarnessProfile } from "./agent/policy.js";
import { parseSubagents } from "./agent/subagents.js";
import { DEFAULT_PROTECTED_PATHS, parseProtectedPaths } from "./github/protectedPaths.js";
import { DEFAULT_TRIAGE_LABELS, type TriageLabels } from "./modes/triage.js";

/** Default shell commands the agent is allowed to run. */
export const DEFAULT_ALLOWED_COMMANDS = [
  "git",
  "ls",
  "cat",
  "mkdir",
  "touch",
  "cp",
  "mv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "python",
  "python3",
  "pip",
  "pytest",
  "go",
  "make",
  "cargo",
  "rustc",
  "sed",
  "grep",
  "find",
  "echo",
];

/** Shell commands that are always blocked, even if the allow-list would permit them. */
export const DEFAULT_DENIED_COMMANDS = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "sudo",
  "su",
  "telnet",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
];

/**
 * Normalize a model id into a provider-prefixed form.
 * `claude-sonnet-5` -> `{ provider: "anthropic", name: "claude-sonnet-5", full: "anthropic:claude-sonnet-5" }`
 * `openai:gpt-5` -> `{ provider: "openai", name: "gpt-5", full: "openai:gpt-5" }`
 */
/** Bare-model-name prefix → provider inference (when no explicit `provider:` prefix). */
const PROVIDER_BY_PREFIX: ReadonlyArray<[RegExp, string]> = [
  [/^claude/i, "anthropic"],
  [/^(gpt|o\d)/i, "openai"],
  [/^gemini/i, "google"],
];

export function normalizeModel(raw: string): {
  provider: string;
  name: string;
  full: string;
} {
  const trimmed = (raw || "").trim();
  const idx = trimmed.indexOf(":");
  if (idx > 0) {
    const provider = trimmed.slice(0, idx).toLowerCase();
    const name = trimmed.slice(idx + 1);
    return { provider, name, full: `${provider}:${name}` };
  }
  // No provider prefix: infer from the model-name prefix, defaulting to anthropic.
  const provider = PROVIDER_BY_PREFIX.find(([re]) => re.test(trimmed))?.[1] ?? "anthropic";
  return { provider, name: trimmed, full: `${provider}:${trimmed}` };
}

/** Parse a boolean input without throwing on empty/missing values. */
export function parseBool(raw: string | undefined): boolean {
  return /^(true|1|yes)$/i.test((raw ?? "").trim());
}

/**
 * Parse an optional positive-number input. Undefined when unset; **throws** on a
 * malformed value. Budget caps are a safety control with no safe default, so a
 * typo (e.g. `"$5"`) must fail the run loudly rather than silently disable the
 * cap and run unbounded.
 */
export function parsePositiveNumber(raw: string | undefined, name: string): number | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number; got "${raw}".`);
  }
  return n;
}

/**
 * Parse an optional positive-integer input. Undefined when unset; throws on a
 * malformed or fractional value (same loud-failure semantics as
 * `parsePositiveNumber`).
 */
export function parsePositiveInteger(raw: string | undefined, name: string): number | undefined {
  const n = parsePositiveNumber(raw, name);
  if (n != null && !Number.isInteger(n)) {
    throw new Error(`${name} must be a positive integer; got "${raw}".`);
  }
  return n;
}

/** Parse a comma/newline-separated list into a trimmed, de-duplicated array. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Read an input, falling back to a list of environment variable names. */
function inputOrEnv(name: string, envNames: string[]): string {
  const fromInput = core.getInput(name);
  if (fromInput) return fromInput;
  for (const e of envNames) {
    const v = process.env[e];
    if (v) return v;
  }
  return "";
}

/** Read a triage label input without ever allowing an empty state label. */
function triageLabelInput(name: string, fallback: string): string {
  return core.getInput(name).trim() || fallback;
}

function loadTriageLabels(): TriageLabels {
  return {
    needsTriage: triageLabelInput("triage_label_needs_triage", DEFAULT_TRIAGE_LABELS.needsTriage),
    needsReproduction: triageLabelInput(
      "triage_label_needs_reproduction",
      DEFAULT_TRIAGE_LABELS.needsReproduction,
    ),
    unableToReproduce: triageLabelInput(
      "triage_label_unable_to_reproduce",
      DEFAULT_TRIAGE_LABELS.unableToReproduce,
    ),
    unableToFix: triageLabelInput("triage_label_unable_to_fix", DEFAULT_TRIAGE_LABELS.unableToFix),
    needsMaintainer: triageLabelInput(
      "triage_label_needs_maintainer",
      DEFAULT_TRIAGE_LABELS.needsMaintainer,
    ),
    fixProposed: triageLabelInput("triage_label_fix_proposed", DEFAULT_TRIAGE_LABELS.fixProposed),
    notActionable: triageLabelInput(
      "triage_label_not_actionable",
      DEFAULT_TRIAGE_LABELS.notActionable,
    ),
    skipped: triageLabelInput("triage_label_skipped", DEFAULT_TRIAGE_LABELS.skipped),
    failed: triageLabelInput("triage_label_failed", DEFAULT_TRIAGE_LABELS.failed),
    run: triageLabelInput("triage_run_label", DEFAULT_TRIAGE_LABELS.run),
  };
}

/** Parse the shell sandbox inputs, failing loudly on anything that would weaken them. */
export function parseShellSandbox(raw: {
  mode?: string;
  image?: string;
  network?: string;
  mcpNetwork?: string;
}): Pick<
  Config,
  "shellSandbox" | "shellSandboxImage" | "shellSandboxNetwork" | "mcpSandboxNetwork"
> {
  const mode = raw.mode?.trim() || "auto";
  const network = raw.network?.trim() || "none";
  // MCP servers usually exist to reach an outside service.
  const mcpNetwork = raw.mcpNetwork?.trim() || "bridge";
  const image = raw.image?.trim() || undefined;
  if (mode !== "auto" && mode !== "none" && mode !== "docker") {
    throw new Error(`shell_sandbox must be "auto", "none", or "docker"; got "${raw.mode}".`);
  }
  if (network !== "none" && network !== "bridge") {
    throw new Error(`shell_sandbox_network must be "none" or "bridge"; got "${raw.network}".`);
  }
  if (mcpNetwork !== "none" && mcpNetwork !== "bridge") {
    throw new Error(`mcp_sandbox_network must be "none" or "bridge"; got "${raw.mcpNetwork}".`);
  }
  if (mode === "docker" && !image) {
    throw new Error(`shell_sandbox "docker" requires shell_sandbox_image.`);
  }
  if (image && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image)) {
    throw new Error(`shell_sandbox_image is not a valid image reference: "${image}".`);
  }
  return {
    shellSandbox: mode === "auto" && image ? "docker" : mode,
    shellSandboxImage: image,
    shellSandboxNetwork: network,
    mcpSandboxNetwork: mcpNetwork,
  };
}

/** Load and normalize action inputs from the environment. */
export function loadConfig(): Config {
  const allowedCommands = parseList(core.getInput("allowed_commands"));
  const deniedCommands = parseList(core.getInput("denied_commands"));

  return {
    triggerPhrase: core.getInput("trigger_phrase") || "@agent",
    prompt: core.getInput("prompt") || undefined,
    model: normalizeModel(core.getInput("model") || "claude-sonnet-5").full,
    baseUrl: core.getInput("base_url") || undefined,
    allowedPermissions: parseList(core.getInput("allowed_permissions") || "write,admin"),
    allowedCommands: allowedCommands.length ? allowedCommands : DEFAULT_ALLOWED_COMMANDS,
    deniedCommands: [...DEFAULT_DENIED_COMMANDS, ...deniedCommands],
    forkAllowLabel: core.getInput("fork_allow_label") || undefined,
    autoRunLabel: core.getInput("auto_run_label") || undefined,
    autoRunAssignee: core.getInput("auto_run_assignee") || undefined,
    autoRunDefaultInstruction: core.getInput("auto_run_default_instruction") || undefined,
    requirePushApproval: parseBool(core.getInput("require_push_approval") || "true"),
    verifiedCommits: parseBool(core.getInput("verified_commits")),
    enableTriage: parseBool(core.getInput("enable_triage")),
    triageAllowedLabels: parseList(core.getInput("triage_allowed_labels")),
    triageModel: core.getInput("triage_model") || undefined,
    triageLabels: loadTriageLabels(),
    triageBotLogins: parseList(core.getInput("triage_bot_logins")),
    triageMaxFailedAttempts:
      parsePositiveInteger(
        core.getInput("triage_max_failed_attempts"),
        "triage_max_failed_attempts",
      ) ?? 3,
    mcpConfig: core.getInput("mcp_config") || "",
    harnessProfile: parseHarnessProfile(core.getInput("harness_profile")),
    filesystemPermissions: parseFilesystemPermissions(core.getInput("filesystem_permissions")),
    subagents: parseSubagents(core.getInput("subagents")),
    protectedPaths: [
      ...DEFAULT_PROTECTED_PATHS,
      ...parseProtectedPaths(core.getInput("protected_paths")),
    ],
    shellTimeoutSeconds:
      parsePositiveInteger(core.getInput("shell_timeout_seconds"), "shell_timeout_seconds") ?? 600,
    ...parseShellSandbox({
      mode: core.getInput("shell_sandbox"),
      image: core.getInput("shell_sandbox_image"),
      network: core.getInput("shell_sandbox_network"),
      mcpNetwork: core.getInput("mcp_sandbox_network"),
    }),
    commentDebounceMs:
      parsePositiveInteger(core.getInput("comment_debounce_ms"), "comment_debounce_ms") ?? 8000,
    maxCostUsd: parsePositiveNumber(core.getInput("max_cost_usd"), "max_cost_usd"),
    maxTotalTokens: parsePositiveNumber(core.getInput("max_total_tokens"), "max_total_tokens"),
    maxRuntimeMinutes: parsePositiveNumber(
      core.getInput("max_runtime_minutes"),
      "max_runtime_minutes",
    ),
    recursionLimit:
      parsePositiveInteger(core.getInput("recursion_limit"), "recursion_limit") ?? 150,
    maxRepeatedToolCalls:
      parsePositiveInteger(core.getInput("max_repeated_tool_calls"), "max_repeated_tool_calls") ??
      8,
  };
}

/** Resolve the provider API key from input/env. */
export function resolveProviderApiKey(): string {
  return inputOrEnv("provider_api_key", [
    "PROVIDER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
  ]);
}

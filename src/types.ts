/**
 * Shared types for the Deep Agent Action control plane.
 */

/** GitHub events this action understands. */
export type SupportedEventName =
  "issue_comment" | "pull_request_review_comment" | "issues" | "pull_request" | "workflow_dispatch";

/**
 * Execution mode resolved from the event:
 *  - "agent": implement a change (edit files → branch/PR).
 *  - "review": review a PR diff and post inline comments (no edits).
 *  - "noop": nothing to do; exit cleanly.
 */
export type Mode = "agent" | "review" | "noop";

/** Normalized, provider-agnostic view of the triggering GitHub event. */
export interface GitHubContext {
  eventName: string;
  eventAction?: string;
  owner: string;
  repo: string;
  /** The login of the actor that triggered the run. */
  actor: string;
  /** Issue or PR number, when the event is tied to one. */
  entityNumber?: number;
  /** True when the event is attached to a pull request (PR, PR review comment, or issue_comment on a PR). */
  isPR: boolean;
  /** The comment / issue / PR body text that may contain the trigger phrase. */
  triggerText?: string;
  /** The id of the comment that triggered the run, when applicable. */
  commentId?: number;
  /** True when this is a PR review comment (uses the pulls review-comment API). */
  isPullRequestReviewComment: boolean;
  /** Fork info for PR events. */
  prHeadRepoFullName?: string;
  prBaseRepoFullName?: string;
  prHeadRef?: string;
  /** Labels on the issue/PR, used for maintainer gating of fork runs. */
  labels: string[];
  /** The label just added by this specific `labeled` event, if any. */
  eventLabel?: string;
  /** The user just assigned by this specific `assigned` event, if any. */
  eventAssignee?: string;
  /** Raw event payload for anything not normalized above. */
  payload: unknown;
}

/** Parsed and normalized action inputs. */
export interface Config {
  triggerPhrase: string;
  /** Explicit prompt for workflow_dispatch (bypasses the phrase). */
  prompt?: string;
  /** Provider-prefixed model id, e.g. "anthropic:claude-sonnet-5". */
  model: string;
  /** Base URL for the `openai-compatible` provider (Groq, xAI, DeepSeek, Ollama, vLLM, …). */
  baseUrl?: string;
  allowedPermissions: string[];
  allowedCommands: string[];
  deniedCommands: string[];
  /** Label that a write-access user can apply to authorize a fork-PR run. */
  forkAllowLabel?: string;
  /** Label that, when applied to an issue, triggers the agent without a trigger-phrase match. */
  autoRunLabel?: string;
  /** User that, when assigned to an issue, triggers the agent without a trigger-phrase match. */
  autoRunAssignee?: string;
  /** Instruction used for an auto-run (label/assignee) event when the issue has no usable text. */
  autoRunDefaultInstruction?: string;
  /** When true, gate landing of changes behind human review (draft PR / proposed branch). */
  requirePushApproval: boolean;
  /**
   * When true, land commits via the GitHub App's `createCommitOnBranch`
   * GraphQL mutation (shows as "Verified" on GitHub) instead of `git push`.
   * Requires GitHub App auth; file-mode/symlink changes are not preserved.
   */
  verifiedCommits: boolean;
  /**
   * When true, a new issue with no trigger phrase is classified by a cheap
   * one-shot model call that decides whether to open a PR, request a review,
   * ask for clarification, add labels, or do nothing. Default off — this
   * changes behavior on every untriggered issue.
   */
  enableTriage: boolean;
  /** Labels the triage classifier may apply; anything outside this list is ignored. */
  triageAllowedLabels: string[];
  /** Model used for the triage classification call; defaults to `model`. */
  triageModel?: string;
  /** Named, visible GitHub labels that encode the opt-in triage lifecycle. */
  triageLabels: import("./modes/triage.js").TriageLabels;
  /** Extra bot logins whose comments must never wake a waiting triage state. */
  triageBotLogins: string[];
  /** Automatic triage failures permitted before retries require manual intervention. */
  triageMaxFailedAttempts: number;
  /** Raw MCP server config JSON (optional); empty string when unset. */
  mcpConfig: string;
  /** Optional validated deepagents harness profile. */
  harnessProfile?: import("deepagents").HarnessProfile;
  /** Optional validated deepagents filesystem permission rules. */
  filesystemPermissions?: import("deepagents").FilesystemPermission[];
  /** Optional validated synchronous specialist-subagent declarations. */
  subagents?: import("./agent/subagents.js").DeepAgentSubagentConfig[];
  /** Immutable protected paths plus workflow-owner extensions that can never be published. */
  protectedPaths: string[];
  shellTimeoutSeconds: number;
  /**
   * Where model-directed shell commands run. `"none"` is the workflow accepting
   * the runner as the boundary; `"auto"` means no image was configured, so runs
   * driven by outside input are refused.
   */
  shellSandbox: "auto" | "none" | "docker";
  /** Container image for `shellSandbox: "docker"`; required in that mode. */
  shellSandboxImage?: string;
  /** Container network for `shellSandbox: "docker"`. */
  shellSandboxNetwork: "none" | "bridge";
  /** Container network for stdio MCP servers under `shellSandbox: "docker"`. */
  mcpSandboxNetwork: "none" | "bridge";
  /** Minimum interval between tracking-comment edits, ms. */
  commentDebounceMs: number;
  /** Abort the run once estimated spend reaches this many USD (needs a known model price). */
  maxCostUsd?: number;
  /** Abort the run once cumulative billed tokens (input + output) reach this many. */
  maxTotalTokens?: number;
  /** Abort the agent once it has run this many minutes; partial work lands for review. */
  maxRuntimeMinutes?: number;
  /** Max agent super-steps per run (defaults to 150). */
  recursionLimit: number;
  /** Stop repeated identical tool calls that make no canonical todo progress. */
  maxRepeatedToolCalls: number;
}

/** Token usage for a run. */
export interface TokenUsage {
  input: number;
  output: number;
}

/** Outcome status surfaced as the `status` output. */
export type RunStatus = "success" | "skipped" | "refused" | "failed";

/** Why a run was deliberately stopped early (partial work lands for review). */
export type StopReason = "budget" | "timeout" | "stalled";

/** One recorded tool invocation for the audit record. */
export interface ToolCallRecord {
  name: string;
  args?: unknown;
  blocked?: boolean;
  reason?: string;
}

/** Structured, retained record of a run (the `result_json` output + artifact). */
export interface RunRecord {
  status: RunStatus;
  mode: Mode;
  model: string;
  instruction?: string;
  plan: { content: string; status: string }[];
  toolCalls: ToolCallRecord[];
  filesChanged: string[];
  prUrl?: string;
  branch?: string;
  summary?: string;
  error?: string;
  tokens?: TokenUsage;
  costUsd?: number;
  /** True when changes were gated behind approval (draft PR / proposed branch). */
  approvalPending?: boolean;
  /** Set when the run was deliberately stopped early (budget, runtime, or stalled loop). */
  stopReason?: StopReason;
  /** Safe detail for a stalled stop; never contains raw tool arguments. */
  stopDetail?: string;
  /** Deduplicated tool/subagent activity observed during the run. */
  activities?: import("./agent/stream.js").StreamActivity[];
}

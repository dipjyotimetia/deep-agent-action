import * as core from "@actions/core";
import { DockerShellRunner, LocalShellRunner, type ShellRunner } from "../agent/shellExec.js";
import { buildShellEnv } from "../agent/env.js";
import {
  SHELL_MAX_OUTPUT_BYTES,
  type buildAgent,
  type BuildAgentOptions,
} from "../agent/createAgent.js";
import { estimateCostUsd } from "../agent/cost.js";
import {
  runAgentStream,
  type BudgetOptions,
  type StreamActivity,
  type StreamResult,
  type TodoItem,
} from "../agent/stream.js";
import type { RepoConfig } from "../config/repoConfig.js";
import type { Octokit } from "../github/client.js";
import { updateTrackingComment, type TrackingState } from "../github/comments.js";
import { isUntrustedPrHead } from "../github/fork.js";
import { landChangesVerified } from "../github/graphqlCommit.js";
import type { MemoryTurn } from "../github/memory.js";
import {
  flattenAgentCommits,
  landChanges,
  listChangedFiles,
  resolveBotIdentity,
  restoreGitTrust,
  type GitTrustSnapshot,
  type LandResult,
} from "../github/ops.js";
import { assertPublishableChanges } from "../github/protectedPaths.js";
import type { Config, GitHubContext, RunRecord } from "../types.js";

type Model = Parameters<typeof buildAgent>[0]["model"];

/** Everything a flow needs from the gated pipeline in `index.ts`. */
export interface FlowParams {
  octokit: Octokit;
  ctx: GitHubContext;
  rootDir: string;
  token: string;
  tokenSource: "app" | "github_token";
  model: Model;
  /** Static-provider model factory for configured specialist overrides. */
  modelFor: (modelSpec: string) => Model;
  instruction: string;
  repoConfig: RepoConfig;
  config: Config;
  record: RunRecord;
  commentId: number | undefined;
  url: string;
  mcpTools: Extract<BuildAgentOptions, { mode: "implement" }>["extraTools"];
  /** Renders a tracking-comment body, re-embedding the thread memory block. */
  renderBody: (state: TrackingState) => string;
  /** Prior turns on this thread, fed back as context and appended to on success. */
  priorMemory: MemoryTurn[];
  /** Issue/PR title, description, and prior human comments, rendered for the agent's prompt. */
  threadContext?: string;
  /** Suffix used for run-scoped branch names (e.g. a bare dispatch, or a proposed-branch run). */
  branchSuffix: string;
  /** The GitHub App slug, when authenticated via an App (used for commit identity). */
  appSlug?: string;
  /** Directory outside the checkout for evicted tool results and summarized history. */
  artifactDir: string;
}

/**
 * Append an optional repo-supplied system prompt to the base one. A fork head
 * can't shape the agent: its config is the PR author's, not the repository's.
 */
export function systemPromptFor(p: FlowParams, base: string): string {
  const extra = isUntrustedPrHead(p.ctx) ? undefined : p.repoConfig.systemPrompt;
  return extra ? `${base}\n\n${extra}` : base;
}

/** Fail fast, before any expensive work, when verified_commits can't be honored. */
export function assertVerifiedCommitsAuth(
  config: Config,
  tokenSource: "app" | "github_token",
): void {
  if (config.verifiedCommits && tokenSource !== "app") {
    throw new Error(
      "verified_commits is enabled but no GitHub App auth is configured (app_id + app_private_key); " +
        "refusing to fall back to unsigned commits.",
    );
  }
}

/** Build the runner for model-directed shell commands, per the workflow's sandbox setting. */
export function createShellRunner(config: Config, rootDir: string): ShellRunner {
  const options = {
    cwd: rootDir,
    env: buildShellEnv(),
    timeoutSeconds: config.shellTimeoutSeconds,
    maxOutputBytes: SHELL_MAX_OUTPUT_BYTES,
  };
  if (config.shellSandbox === "docker") {
    return new DockerShellRunner(options, {
      image: config.shellSandboxImage!,
      network: config.shellSandboxNetwork,
    });
  }
  return new LocalShellRunner(options);
}

/** Options shared by every `runAgentStream` call, wired to the tracking comment. */
function streamOptions(p: FlowParams) {
  const { config, ctx } = p;
  const budget: BudgetOptions = {
    model: config.model,
    maxCostUsd: config.maxCostUsd,
    maxTotalTokens: config.maxTotalTokens,
  };
  return {
    threadId: `${ctx.owner}/${ctx.repo}#${ctx.entityNumber ?? "dispatch"}`,
    debounceMs: config.commentDebounceMs,
    onProgress: mirrorProgress(p),
    onActivity: mirrorActivity(p),
    budget,
    maxRuntimeMs: config.maxRuntimeMinutes != null ? config.maxRuntimeMinutes * 60_000 : undefined,
    recursionLimit: config.recursionLimit,
    maxRepeatedToolCalls: config.maxRepeatedToolCalls,
  };
}

/** Run the agent and copy its outcome onto the run record. */
export async function streamIntoRecord(
  p: FlowParams,
  agent: Parameters<typeof runAgentStream>[0],
  input: unknown,
): Promise<StreamResult> {
  const result = await runAgentStream(agent, input, streamOptions(p));
  const { record, config } = p;
  record.tokens = result.tokens;
  record.costUsd = result.costUsd ?? estimateCostUsd(config.model, result.tokens);
  record.plan = result.todos;
  record.stopReason = result.stopped;
  record.stopDetail = result.stopDetail;
  record.activities = result.activities;
  return result;
}

/**
 * Update the tracking comment without letting a failure reach the agent run. The
 * comment is a progress display; a GitHub hiccup must not throw away the work.
 */
async function mirror(p: FlowParams, state: TrackingState): Promise<void> {
  if (p.commentId == null) return;
  try {
    await updateTrackingComment(p.octokit, p.ctx, p.commentId, p.renderBody(state));
  } catch (err) {
    core.warning(
      `Could not update the tracking comment: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Reflect the agent's plan into the tracking comment. */
function mirrorProgress(p: FlowParams): (todos: TodoItem[]) => Promise<void> {
  return async (todos) => {
    p.record.plan = todos;
    await mirror(p, { status: "working", instruction: p.instruction, todos, runUrl: p.url });
  };
}

/** Record typed activity and occasionally mirror the latest event to GitHub. */
function mirrorActivity(p: FlowParams): (activity: StreamActivity) => Promise<void> {
  let lastMirrorAt = 0;
  return async (activity) => {
    p.record.activities ??= [];
    p.record.activities.push(activity);
    const now = Date.now();
    if (now - lastMirrorAt < p.config.commentDebounceMs) return;
    lastMirrorAt = now;
    await mirror(p, {
      status: "working",
      instruction: p.instruction,
      todos: p.record.plan,
      activity,
      runUrl: p.url,
    });
  };
}

/** Render the closing tracking comment for a finished flow. */
export async function postFinalComment(
  p: FlowParams,
  state: Pick<TrackingState, "summary" | "todos" | "memory">,
): Promise<void> {
  const { record, commentId } = p;
  if (commentId == null) return;
  await updateTrackingComment(
    p.octokit,
    p.ctx,
    commentId,
    p.renderBody({
      status: "success",
      instruction: p.instruction,
      prUrl: record.prUrl,
      branch: record.branch,
      approvalPending: record.approvalPending,
      stopReason: record.stopReason,
      stopDetail: record.stopDetail,
      activity: record.activities?.at(-1),
      tokens: record.tokens,
      costUsd: record.costUsd,
      runUrl: p.url,
      ...state,
    }),
  );
}

/**
 * Land the working tree's changes via the verified (GraphQL) or plain-git path,
 * per config. Runs after the agent's shell has been terminated: first make the
 * Git directory trustworthy again, then treat everything since the agent started
 * as one change, then decide whether it may be published.
 */
export async function landChangesForRun(
  p: FlowParams,
  gitTrust: GitTrustSnapshot,
  args: {
    isPRMode: boolean;
    instruction: string;
    branchSuffix: string;
    requireApproval: boolean;
    continuingBranch?: boolean;
    baseBranch?: string;
  },
): Promise<LandResult> {
  restoreGitTrust(gitTrust);
  flattenAgentCommits(p.rootDir, gitTrust.startSha);
  assertPublishableChanges(listChangedFiles(p.rootDir), p.config.protectedPaths);

  // Fork work has no branch here to update, so it can only ever be a proposal.
  const landArgs = {
    ...args,
    requireApproval: args.requireApproval || isUntrustedPrHead(p.ctx),
  };
  if (p.config.verifiedCommits) {
    return landChangesVerified({
      octokit: p.octokit,
      ctx: p.ctx,
      rootDir: p.rootDir,
      startSha: gitTrust.startSha,
      ...landArgs,
    });
  }
  const identity = await resolveBotIdentity(p.octokit, p.appSlug);
  return landChanges({
    octokit: p.octokit,
    ctx: p.ctx,
    rootDir: p.rootDir,
    token: p.token,
    identity,
    ...landArgs,
  });
}

/** Copy a landing's outcome onto the run record. */
export function applyLandResult(record: RunRecord, land: LandResult): void {
  record.filesChanged = land.filesChanged;
  record.branch = land.branch;
  record.prUrl = land.prUrl;
  record.approvalPending = land.approvalPending;
}

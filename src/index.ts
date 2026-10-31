import * as core from "@actions/core";
import { context } from "@actions/github";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, normalizeModel, resolveProviderApiKey } from "./config.js";
import { loadRepoConfig } from "./config/repoConfig.js";
import { parseContext } from "./github/context.js";
import { detectMode, isReviewRequest, isReviewAndFixRequest } from "./modes/detector.js";
import { finalizeTriageRun, runTriageCheck, type TriageHandoff } from "./modes/triage.js";
import { resolveToken } from "./github/auth.js";
import { makeOctokit, githubServerUrl, type Octokit } from "./github/client.js";
import { forkRunAllowed } from "./github/fork.js";
import { checkActorPermission } from "./github/validation/permissions.js";
import { checkActorIsHuman } from "./github/validation/actor.js";
import { extractInstruction } from "./github/validation/trigger.js";
import {
  addEyesReaction,
  createTrackingComment,
  findTrackingComment,
  updateTrackingComment,
  renderTrackingBody,
  type TrackingState,
} from "./github/comments.js";
import { fetchThread, type ThreadInfo } from "./github/thread.js";
import { parseMemory, type MemoryTurn } from "./github/memory.js";
import { createModel } from "./agent/model.js";
import { loadMcpTools } from "./agent/mcp.js";
import { buildRunBranchSuffix } from "./github/ops.js";
import { runImplement } from "./flows/implement.js";
import { runReview } from "./flows/review.js";
import { smokeCheck } from "./smoke.js";
import { buildFailureRecord, emitOutputs } from "./outputs.js";
import type { GitHubContext, Mode, RunRecord } from "./types.js";

function runUrl(ctx: GitHubContext): string {
  return `${githubServerUrl()}/${ctx.owner}/${ctx.repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
}

/** When the event is a PR comment, the payload lacks head/base repo info; fetch it. */
async function resolvePrRefs(octokit: Octokit, ctx: GitHubContext): Promise<void> {
  if (!ctx.isPR || ctx.entityNumber == null || ctx.prHeadRepoFullName) return;
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: ctx.entityNumber,
    });
    ctx.prHeadRepoFullName = pr.head.repo?.full_name ?? undefined;
    ctx.prBaseRepoFullName = pr.base.repo?.full_name ?? undefined;
    ctx.prHeadRef = pr.head.ref;
  } catch {
    // Leave fork status undetermined; fork gating treats PRs as untrusted then.
  }
}

/** Reuse the existing sticky tracking comment if present, else create one. */
async function getOrCreateComment(
  octokit: Octokit,
  ctx: GitHubContext,
  body: string,
): Promise<number | undefined> {
  const existing = await findTrackingComment(octokit, ctx);
  return upsertComment(octokit, ctx, existing?.id, body);
}

/** Update the tracking comment by id when known, else create it. */
async function upsertComment(
  octokit: Octokit,
  ctx: GitHubContext,
  existingId: number | undefined,
  body: string,
): Promise<number | undefined> {
  if (existingId != null) {
    await updateTrackingComment(octokit, ctx, existingId, body);
    return existingId;
  }
  return createTrackingComment(octokit, ctx, body);
}

async function run(): Promise<void> {
  if (process.env.DEEP_AGENT_SMOKE === "1") {
    await smokeCheck();
    return;
  }

  const ctx = parseContext({
    eventName: context.eventName,
    actor: context.actor,
    repo: context.repo,
    payload: context.payload,
  });
  const rootDir = process.env.GITHUB_WORKSPACE || process.cwd();

  // Load optional repository guidance; execution policy stays workflow-owned.
  const repoConfig = loadRepoConfig(rootDir);
  let config = loadConfig();

  const record: RunRecord = {
    status: "skipped",
    mode: "noop",
    model: config.model,
    plan: [],
    toolCalls: [],
    filesChanged: [],
  };

  // P0-1: route the event.
  const modeDetected = detectMode(ctx, {
    triggerPhrase: config.triggerPhrase,
    prompt: config.prompt,
    autoRunLabel: config.autoRunLabel,
    autoRunAssignee: config.autoRunAssignee,
  });
  // A new issue with no trigger phrase is otherwise a silent no-op; when
  // enabled, triage gets one shot at classifying it (open a PR, request a
  // review, ask for clarification, add labels) before we give up on it.
  // Explicit triggers (trigger phrase, auto_run_label/assignee) always win —
  // triage only ever runs when nothing else already matched.
  let triageHandoff: TriageHandoff | undefined;
  if (
    modeDetected === "noop" &&
    config.enableTriage &&
    (ctx.eventName === "issues" || (ctx.eventName === "issue_comment" && !ctx.isPR))
  ) {
    triageHandoff = await runTriageCheck({ ctx, config });
  }

  if (modeDetected === "noop" && !triageHandoff) {
    core.info("No trigger phrase / prompt for this event; exiting with no side effects.");
    await emitOutputs(record);
    return;
  }

  // A triage-originated run always lands behind the approval gate (draft PR /
  // proposed branch) regardless of the repo's require_push_approval setting —
  // a misclassification should never push/merge unsupervised.
  if (triageHandoff) config = { ...config, requirePushApproval: true };

  // An auto-run label/assignee bypasses the trigger phrase, so the issue may have
  // no phrase to extract an instruction after — fall back to the whole triggerText
  // (already extracted by extractInstruction when the phrase is absent), and if
  // that's still empty, a configurable default instruction.
  const isAutoRun =
    ctx.eventName === "issues" &&
    ((config.autoRunLabel && ctx.eventLabel === config.autoRunLabel) ||
      (config.autoRunAssignee && ctx.eventAssignee === config.autoRunAssignee));

  // P0-2: resolve the instruction.
  const instruction =
    triageHandoff?.instruction ||
    config.prompt?.trim() ||
    extractInstruction(ctx.triggerText, config.triggerPhrase) ||
    (isAutoRun ? (config.autoRunDefaultInstruction ?? "") : "");
  record.instruction = instruction;
  if (!instruction) {
    core.info("Trigger matched but no instruction text was provided; exiting.");
    await emitOutputs(record);
    return;
  }

  // Refine to review mode when a PR mention asks for a review (or triage
  // decided this issue is actually a PR asking for one). "review and fix"
  // "review and fix" additionally applies the review's own single-line
  // suggestions and lands them as a commit.
  const mode: Mode = ctx.isPR && isReviewRequest(instruction) ? "review" : "agent";
  record.mode = mode;
  const applyFixes = mode === "review" && isReviewAndFixRequest(instruction);

  // P0-12: mint a scoped, short-lived token — reuse triage's if it already
  // minted one (it already ran the same auth checks below for this actor).
  const tokenResult =
    triageHandoff?.tokenResult ??
    (await resolveToken({
      owner: ctx.owner,
      repo: ctx.repo,
      appId: core.getInput("app_id") || process.env.APP_ID,
      privateKey: core.getInput("app_private_key") || process.env.APP_PRIVATE_KEY,
      githubToken: core.getInput("github_token") || process.env.GITHUB_TOKEN,
    }));
  const octokit = makeOctokit(tokenResult.token);

  await resolvePrRefs(octokit, ctx);

  // P0-4: fork-PR secret protection (before any agent execution).
  const fork = forkRunAllowed(ctx, config.forkAllowLabel);
  if (!fork.allowed) {
    await refuse(octokit, ctx, record, fork.reason!);
    return;
  }

  // P0-3: authorization — independent checks run together. Ignore bots
  // silently. Skipped for a triage handoff: runTriageCheck already verified
  // this exact actor/repo pass the same checks moments ago.
  if (!triageHandoff) {
    const [human, perm] = await Promise.all([
      checkActorIsHuman(octokit, ctx.actor),
      checkActorPermission(octokit, {
        owner: ctx.owner,
        repo: ctx.repo,
        username: ctx.actor,
        allowed: config.allowedPermissions,
      }),
    ]);
    if (!human.ok) {
      core.info(`Ignoring non-human actor: ${human.reason}`);
      record.status = "refused";
      await emitOutputs(record);
      return;
    }
    if (!perm.ok) {
      await refuse(octokit, ctx, record, perm.reason!);
      return;
    }
  }

  const url = runUrl(ctx);
  const branchSuffix = buildRunBranchSuffix();

  // M2: only implement mode can use MCP tools, so review never starts a server.
  // Loaded before the `try` whose `finally` closes it, so nothing below can leave
  // a server process keeping the action alive.
  const mcp = await loadMcpTools(mode === "agent" ? config.mcpConfig : "");
  const artifactDir = mkdtempSync(
    join(process.env.RUNNER_TEMP || tmpdir(), "deep-agent-artifacts-"),
  );

  let commentId: number | undefined;
  // (The pre-authorization `refuse()` path renders before this point and
  // intentionally does not preserve memory.)
  let priorMemory: MemoryTurn[] = [];
  const renderBody = (state: TrackingState): string =>
    renderTrackingBody({ ...state, memory: state.memory ?? priorMemory });

  try {
    // P0-5: acknowledge and find the existing tracking comment. We find (not yet
    // upsert) the comment first so prior thread memory is read before we overwrite
    // it. A triage handoff is guaranteed to have none yet (runTriageCheck only
    // hands off when its own lookup found none), so skip re-fetching it.
    const [, thread] = await Promise.all([
      addEyesReaction(octokit, ctx),
      triageHandoff ? Promise.resolve<ThreadInfo>({}) : fetchThread(octokit, ctx),
    ]);
    priorMemory = parseMemory(thread.trackingComment?.body);
    commentId = await upsertComment(
      octokit,
      ctx,
      thread.trackingComment?.id,
      renderBody({ status: "working", instruction, runUrl: url }),
    );

    const apiKey = resolveProviderApiKey();
    const modelFor = (modelSpec: string) => {
      const { provider, name } = normalizeModel(modelSpec);
      return createModel({ provider, model: name, apiKey, baseUrl: config.baseUrl });
    };
    const flow = {
      octokit,
      ctx,
      rootDir,
      token: tokenResult.token,
      tokenSource: tokenResult.source,
      appSlug: tokenResult.appSlug,
      model: modelFor(config.model),
      modelFor,
      instruction,
      repoConfig,
      config,
      record,
      commentId,
      url,
      branchSuffix,
      mcpTools: mcp.tools,
      renderBody,
      priorMemory,
      threadContext: thread.context,
      artifactDir,
    };

    if (mode === "review") await runReview({ ...flow, applyFixes });
    else await runImplement(flow);

    if (triageHandoff) {
      await finalizeTriageRun({
        octokit,
        ctx,
        config,
        filesChanged: record.filesChanged,
      });
    }
    await emitOutputs(record);
  } catch (err) {
    // P0-11: clean failure with an actionable comment.
    const message = err instanceof Error ? err.message : String(err);
    record.status = "failed";
    record.error = message;
    if (triageHandoff) {
      await finalizeTriageRun({ octokit, ctx, config, filesChanged: [], failed: true }).catch(
        () => {},
      );
    }
    if (commentId != null) {
      await updateTrackingComment(
        octokit,
        ctx,
        commentId,
        renderBody({
          status: "failed",
          instruction,
          todos: record.plan,
          summary: record.summary,
          prUrl: record.prUrl,
          branch: record.branch,
          approvalPending: record.approvalPending,
          tokens: record.tokens,
          costUsd: record.costUsd,
          error: message,
          runUrl: url,
        }),
      ).catch(() => {});
    }
    await emitOutputs(record);
    core.setFailed(`Deep Agent run failed: ${message}`);
  } finally {
    await mcp.close().catch(() => {});
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

/** Post a refusal comment (when possible), set status, emit outputs, and exit cleanly. */
async function refuse(
  octokit: Octokit,
  ctx: GitHubContext,
  record: RunRecord,
  reason: string,
): Promise<void> {
  record.status = "refused";
  record.error = reason;
  core.warning(reason);
  if (ctx.entityNumber != null) {
    await getOrCreateComment(
      octokit,
      ctx,
      renderTrackingBody({ status: "refused", error: reason }),
    ).catch(() => {});
  }
  await emitOutputs(record);
}

run().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  await emitOutputs(buildFailureRecord(message, core.getInput("model") || "unknown")).catch(
    () => {},
  );
  core.setFailed(`Deep Agent action crashed: ${message}`);
});

import { buildAgent } from "../agent/createAgent.js";
import { buildReviewSystemPrompt, buildReviewUserMessage } from "../agent/prompt.js";
import type { StreamResult } from "../agent/stream.js";
import { isUntrustedPrHead } from "../github/fork.js";
import { buildMemoryContext, appendTurn } from "../github/memory.js";
import { captureGitTrust, checkoutPrHead } from "../github/ops.js";
import {
  applyReviewSuggestions,
  fetchPrFiles,
  parseFindings,
  postReview,
  type ReviewResult,
} from "../github/review.js";
import {
  applyLandResult,
  assertVerifiedCommitsAuth,
  landChangesForRun,
  postFinalComment,
  streamIntoRecord,
  systemPromptFor,
  type FlowParams,
} from "./shared.js";

/**
 * Interpret the agent's structured response. A review is the action's claim that
 * someone looked at the change, so a run that returned none fails visibly rather
 * than posting an empty review that reads as approval.
 */
export function reviewFromResult(result: StreamResult): ReviewResult {
  if (result.structuredResponse === undefined) {
    const why = result.stopped
      ? `it stopped early (${result.stopDetail ?? result.stopped})`
      : "the agent did not return one";
    throw new Error(`No review was posted because ${why}.`);
  }
  const review = parseFindings(result.structuredResponse);
  if (!review.summary) review.summary = result.summary;
  return review;
}

/**
 * Review flow (M3): review the PR diff and post inline comments; no edits.
 * When `applyFixes` is set by a "review and fix" mention, findings with a clean single-line `suggestion` are
 * also applied directly to the files and landed as a commit before the
 * review is posted — findings without one still surface as comments.
 */
export async function runReview(p: FlowParams & { applyFixes: boolean }): Promise<void> {
  const { octokit, ctx, rootDir, instruction, config, record } = p;

  if (p.applyFixes) assertVerifiedCommitsAuth(config, p.tokenSource);

  // Check out the PR head so the agent reads the proposed code (not the base
  // branch actions/checkout left), keeping its line numbers aligned to the diff.
  if (ctx.prHeadRef) checkoutPrHead(rootDir, p.token, ctx);
  // Only a "review and fix" run lands anything, so only it needs a Git snapshot.
  const gitTrust = p.applyFixes ? captureGitTrust(rootDir) : undefined;

  const files = await fetchPrFiles(octokit, ctx);
  const agent = buildAgent({
    model: p.model,
    modelSpec: config.model,
    rootDir,
    mode: "review",
    systemPrompt: systemPromptFor(p, buildReviewSystemPrompt(ctx)),
    harnessProfile: config.harnessProfile,
    filesystemPermissions: config.filesystemPermissions,
    allowedCommands: config.allowedCommands,
    deniedCommands: config.deniedCommands,
    shellTimeoutSeconds: config.shellTimeoutSeconds,
    toolCallRecord: record.toolCalls,
    trustRepoGuidance: !isUntrustedPrHead(ctx),
    artifactDir: p.artifactDir,
  });

  const result = await streamIntoRecord(p, agent, {
    messages: [
      {
        role: "user",
        content: buildReviewUserMessage(
          instruction,
          files,
          buildMemoryContext(p.priorMemory),
          p.threadContext,
        ),
      },
    ],
  });
  const review = reviewFromResult(result);

  let unhandled = review.findings;
  let fixSummary = "";

  if (gitTrust) {
    const { applied, unhandled: rest } = applyReviewSuggestions(
      rootDir,
      review.findings,
      new Set(files.map((file) => file.filename)),
    );
    unhandled = rest;
    if (applied.length > 0) {
      applyLandResult(
        record,
        await landChangesForRun(p, gitTrust, {
          isPRMode: true,
          instruction: `Apply ${applied.length} review suggestion(s)`,
          branchSuffix: p.branchSuffix,
          requireApproval: config.requirePushApproval,
        }),
      );
    }
    fixSummary = `${applied.length} suggestion(s) applied directly, ${unhandled.length} require manual review.`;
  }

  // Post the review — only the findings that weren't auto-applied still
  // surface as comments (an applied suggestion is already in the diff).
  await postReview(octokit, ctx, { summary: review.summary, findings: unhandled });
  record.summary = [
    `Reviewed ${files.length} file(s); posted ${unhandled.length} inline comment(s).`,
    fixSummary,
  ]
    .filter(Boolean)
    .join(" ");
  record.status = "success";

  await postFinalComment(p, {
    summary: `${record.summary}\n\n${review.summary}`,
    memory: appendTurn(p.priorMemory, {
      instruction,
      summary: record.summary ?? "",
      prUrl: record.prUrl,
    }),
  });
}

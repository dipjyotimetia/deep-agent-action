import * as core from "@actions/core";
import { buildAgent } from "../agent/createAgent.js";
import { buildSystemPrompt, buildUserMessage } from "../agent/prompt.js";
import type { StreamResult } from "../agent/stream.js";
import { githubServerUrl } from "../github/client.js";
import { isUntrustedPrHead } from "../github/fork.js";
import { appendTurn, buildMemoryContext } from "../github/memory.js";
import {
  captureGitTrust,
  checkoutIssueBranchIfExists,
  checkoutPrHead,
  generateBranchName,
  getCurrentBranch,
  stripCheckoutCredentials,
} from "../github/ops.js";
import { isResumeRequest } from "../modes/detector.js";
import {
  applyLandResult,
  assertVerifiedCommitsAuth,
  createShellRunner,
  landChangesForRun,
  postFinalComment,
  streamIntoRecord,
  systemPromptFor,
  type FlowParams,
} from "./shared.js";

/** Agent (implement) flow: edit files, then branch/PR or push (with optional approval gate). */
export async function runImplement(p: FlowParams): Promise<void> {
  const { ctx, rootDir, instruction, config, record, branchSuffix } = p;
  const isPRMode = ctx.isPR;

  // Fail fast (before spending an agent run) rather than silently falling
  // back to unsigned commits when verified_commits is requested without App auth.
  assertVerifiedCommitsAuth(config, p.tokenSource);
  stripCheckoutCredentials(rootDir, `${githubServerUrl()}/${ctx.owner}/${ctx.repo}.git`);

  // PR mode: switch to the PR head so the agent edits the right branch.
  if (isPRMode && ctx.prHeadRef) checkoutPrHead(rootDir, p.token, ctx);

  // Issue/dispatch mode: capture the true default branch before any checkout,
  // then continue on the issue's existing deep-agent branch if a prior
  // mention already created one, so this run extends the same branch/PR
  // instead of opening a new one.
  let baseBranch: string | undefined;
  let continuingBranch = false;
  if (!isPRMode) {
    baseBranch = getCurrentBranch(rootDir);
    if (ctx.entityNumber != null) {
      const branch = generateBranchName(ctx, branchSuffix);
      continuingBranch = checkoutIssueBranchIfExists(rootDir, p.token, ctx.owner, ctx.repo, branch);
    }
  }

  const gitTrust = captureGitTrust(rootDir);
  const shell = createShellRunner(config, rootDir);
  await shell.prepare();

  const agent = buildAgent({
    model: p.model,
    modelSpec: config.model,
    rootDir,
    mode: "implement",
    systemPrompt: systemPromptFor(p, buildSystemPrompt(ctx, { isPRMode })),
    harnessProfile: config.harnessProfile,
    filesystemPermissions: config.filesystemPermissions,
    allowedCommands: config.allowedCommands,
    deniedCommands: config.deniedCommands,
    shellTimeoutSeconds: config.shellTimeoutSeconds,
    toolCallRecord: record.toolCalls,
    extraTools: p.mcpTools,
    subagents: config.subagents,
    subagentModelFor: p.modelFor,
    shellRunner: shell,
    trustRepoGuidance: !isUntrustedPrHead(ctx),
    artifactDir: p.artifactDir,
  });

  // "continue"/"resume" seeds the prior turn's incomplete todo list directly
  // into the agent's initial state, so the plan picks up where it left off
  // instead of starting over.
  const resume = isResumeRequest(instruction);
  const resumeTodos = resume ? p.priorMemory.at(-1)?.openTodos : undefined;

  const landArgs = { isPRMode, instruction, branchSuffix, continuingBranch, baseBranch };

  let result: StreamResult;
  try {
    result = await streamIntoRecord(p, agent, {
      messages: [
        {
          role: "user",
          content: buildUserMessage(
            instruction,
            ctx,
            buildMemoryContext(p.priorMemory, { resume }),
            p.threadContext,
          ),
        },
      ],
      ...(resumeTodos?.length ? { todos: resumeTodos } : {}),
    });
  } catch (err) {
    // A provider or infrastructure failure shouldn't discard finished edits:
    // propose them for review, then report the original failure.
    await shell.terminateAll();
    try {
      applyLandResult(
        record,
        await landChangesForRun(p, gitTrust, { ...landArgs, requireApproval: true }),
      );
    } catch (landErr) {
      core.warning(
        `Could not land partial work: ${landErr instanceof Error ? landErr.message : String(landErr)}`,
      );
    }
    throw err;
  }
  // Nothing the agent started may still be writing while the control plane lands.
  await shell.terminateAll();
  record.summary = result.summary;

  // P0-7 + M4: commit + open PR / push, gated by approval when configured. A
  // budget or runtime stop forces the approval path so partial work lands as a
  // draft for review rather than directly on a branch.
  applyLandResult(
    record,
    await landChangesForRun(p, gitTrust, {
      ...landArgs,
      requireApproval: config.requirePushApproval || record.stopReason != null,
    }),
  );
  record.status = "success";

  await postFinalComment(p, {
    todos: record.plan,
    summary: record.summary,
    memory: appendTurn(p.priorMemory, {
      instruction,
      summary: record.summary ?? "",
      prUrl: record.prUrl,
      openTodos: record.plan,
    }),
  });
}

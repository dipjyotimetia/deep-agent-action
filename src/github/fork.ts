import type { GitHubContext } from "../types.js";

/**
 * Whether this PR originates from a fork. Returns `undefined` when the head/base
 * repo cannot be determined from the payload (e.g. an `issue_comment` on a PR,
 * where the caller must resolve head info via a PR fetch first).
 */
export function isForkPr(ctx: GitHubContext): boolean | undefined {
  if (!ctx.isPR) return false;
  if (!ctx.prHeadRepoFullName || !ctx.prBaseRepoFullName) return undefined;
  return ctx.prHeadRepoFullName !== ctx.prBaseRepoFullName;
}

/**
 * Whether a PR's head must be treated as untrusted fork code: a confirmed fork,
 * or a PR whose head repository could not be determined. Its branch name means
 * nothing in this repository, and its repository guidance is not ours.
 */
export function isUntrustedPrHead(ctx: GitHubContext): boolean {
  return ctx.isPR && isForkPr(ctx) !== false;
}

/**
 * Decide whether a run is permitted given fork status.
 *
 * Default-deny for fork PRs: untrusted fork contexts never reach secrets or a
 * write token unless a maintainer has explicitly gated the run by applying the
 * configured `forkAllowLabel` (which only a write-access user can add).
 */
export function forkRunAllowed(
  ctx: GitHubContext,
  forkAllowLabel: string | undefined,
): { allowed: boolean; reason?: string } {
  const fork = isForkPr(ctx);

  if (fork === false) return { allowed: true };

  if (fork === undefined) {
    // Could not determine fork status; treat PR contexts as untrusted unless gated.
    if (!ctx.isPR) return { allowed: true };
  }

  // From here, this is (or may be) a fork PR.
  if (forkAllowLabel && ctx.labels.includes(forkAllowLabel)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: forkAllowLabel
      ? `This pull request comes from a fork. A maintainer must apply the \`${forkAllowLabel}\` label to authorize the agent on fork code.`
      : `This pull request comes from a fork. Running the agent on fork PRs is disabled (no \`fork_allow_label\` configured) to protect repository secrets.`,
  };
}

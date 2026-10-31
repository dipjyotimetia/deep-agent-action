import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Octokit } from "./client.js";
import { isUntrustedPrHead } from "./fork.js";
import { truncateBody } from "./text.js";
import {
  assertDirectPushAllowed,
  buildPrBody,
  commitTitle,
  compareUrl,
  explainGitHubError,
  generateBranchName,
  proposedBranchName,
  reuseExistingPr,
  runGit,
  type LandResult,
} from "./ops.js";
import type { GitHubContext } from "../types.js";

export interface FileAddition {
  path: string;
  contents: string;
}

export interface FileDeletion {
  path: string;
}

export interface Changeset {
  additions: FileAddition[];
  deletions: FileDeletion[];
  /** All paths touched (additions + deletions), for the "any changes?" check and reporting. */
  filesChanged: string[];
}

/**
 * Classify `git status --porcelain` output into added/modified paths (to be
 * read + base64-encoded) and deleted paths. Renames have no dedicated
 * `createCommitOnBranch` primitive, so they're modeled as a deletion of the
 * old path plus an addition of the new one. Pure and git-independent so it's
 * unit-testable without a real repo.
 */
export function parsePorcelainStatus(porcelain: string): {
  additionPaths: string[];
  deletionPaths: string[];
} {
  const additionPaths: string[] = [];
  const deletionPaths: string[] = [];
  if (!porcelain) return { additionPaths, deletionPaths };

  for (const line of porcelain.split("\n")) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    if (status.includes("R")) {
      const [oldPath, newPath] = rest.split(" -> ").map((p) => p.trim());
      if (oldPath) deletionPaths.push(oldPath);
      if (newPath) additionPaths.push(newPath);
      continue;
    }
    if (status.includes("D")) {
      deletionPaths.push(rest.trim());
      continue;
    }
    // A (added), M (modified), ?? (untracked), C (copied) all read as additions.
    additionPaths.push(rest.trim());
  }
  return { additionPaths, deletionPaths };
}

/**
 * Read a changed file's bytes for publishing. A symlink is rejected when it
 * leaves the checkout: this path publishes file contents rather than the link,
 * so following one could put any file readable on the runner into a commit.
 */
function readPublishableFile(rootDir: string, path: string): Buffer {
  const full = join(rootDir, path);
  if (lstatSync(full).isSymbolicLink()) {
    const root = realpathSync(rootDir);
    const rel = relative(root, realpathSync(full));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Refusing to publish ${path}: it is a symlink leaving the repository.`);
    }
  }
  return readFileSync(full);
}

/**
 * Compute the working tree's uncommitted changes as `createCommitOnBranch`
 * inputs. Every addition is read as raw bytes and base64-encoded (binary
 * safe). Known limitation: the GraphQL mutation has no file-mode field, so
 * executable bits and symlinks are not preserved — changed files always land
 * as mode 100644 regardless of their mode in the working tree.
 */
export function computeChangeset(rootDir: string): Changeset {
  const porcelain = runGit(["status", "--porcelain", "--untracked-files=all"], rootDir);
  const { additionPaths, deletionPaths } = parsePorcelainStatus(porcelain);
  return {
    additions: additionPaths.map((path) => ({
      path,
      contents: readPublishableFile(rootDir, path).toString("base64"),
    })),
    deletions: deletionPaths.map((path) => ({ path })),
    filesChanged: [...additionPaths, ...deletionPaths],
  };
}

/** The current tip commit SHA of a branch. */
async function getRefOid(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch });
  return data.commit.sha;
}

/**
 * Create the branch (at `fromSha`) if it doesn't already exist remotely.
 * `createCommitOnBranch` requires an existing ref — it cannot create one.
 */
export async function ensureRefExists(
  octokit: Octokit,
  params: { owner: string; repo: string; branch: string; fromSha: string },
): Promise<void> {
  try {
    await octokit.rest.git.getRef({
      owner: params.owner,
      repo: params.repo,
      ref: `heads/${params.branch}`,
    });
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    await octokit.rest.git.createRef({
      owner: params.owner,
      repo: params.repo,
      ref: `refs/heads/${params.branch}`,
      sha: params.fromSha,
    });
  }
}

const CREATE_COMMIT_ON_BRANCH = `
  mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit { oid url }
    }
  }
`;

/** Call the `createCommitOnBranch` GraphQL mutation; the resulting commit is GitHub-verified. */
export async function createCommitOnBranchMutation(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    branch: string;
    expectedHeadOid: string;
    message: string;
    additions: FileAddition[];
    deletions: FileDeletion[];
  },
): Promise<{ oid: string; url: string }> {
  const result = await octokit
    .graphql<{
      createCommitOnBranch: { commit: { oid: string; url: string } };
    }>(CREATE_COMMIT_ON_BRANCH, {
      input: {
        branch: {
          repositoryNameWithOwner: `${params.owner}/${params.repo}`,
          branchName: params.branch,
        },
        message: { headline: params.message },
        expectedHeadOid: params.expectedHeadOid,
        fileChanges: {
          additions: params.additions,
          deletions: params.deletions,
        },
      },
    })
    .catch((err: unknown) => {
      throw new Error(explainGitHubError(err instanceof Error ? err.message : String(err)));
    });
  return result.createCommitOnBranch.commit;
}

/**
 * The GraphQL-commit analog of `landChanges` (see ops.ts) — same three
 * sub-paths (push to PR branch / push a proposed branch / branch off + open a
 * PR), but every commit lands via `createCommitOnBranch` instead of
 * `git commit` + `git push`, so it shows as "Verified" on GitHub. Requires
 * GitHub App auth (the mutation is authorized the same way as the REST calls,
 * via the installation token already on `octokit`).
 */
export async function landChangesVerified(params: {
  octokit: Octokit;
  ctx: GitHubContext;
  rootDir: string;
  isPRMode: boolean;
  instruction: string;
  branchSuffix: string;
  requireApproval: boolean;
  /** True when a prior run already created this issue's branch (continuity). */
  continuingBranch?: boolean;
  /** The repo's default branch; required for the issue/dispatch new-branch path. */
  baseBranch?: string;
  /** The commit the agent started from; a fork PR's head has no branch here to look up. */
  startSha?: string;
}): Promise<LandResult> {
  const { octokit, ctx, rootDir, isPRMode, instruction, branchSuffix } = params;

  const changeset = computeChangeset(rootDir);
  const filesChanged = changeset.filesChanged;
  if (filesChanged.length === 0) return { filesChanged };

  const title = commitTitle(instruction);

  if (isPRMode) {
    if (!ctx.prHeadRef) {
      throw new Error("PR mode requires a resolved head branch (prHeadRef); cannot push changes.");
    }
    if (params.requireApproval) {
      const proposed = proposedBranchName(ctx, branchSuffix);
      const baseOid =
        isUntrustedPrHead(ctx) && params.startSha
          ? params.startSha
          : await getRefOid(octokit, ctx.owner, ctx.repo, ctx.prHeadRef);
      await ensureRefExists(octokit, {
        owner: ctx.owner,
        repo: ctx.repo,
        branch: proposed,
        fromSha: baseOid,
      });
      await createCommitOnBranchMutation(octokit, {
        owner: ctx.owner,
        repo: ctx.repo,
        branch: proposed,
        expectedHeadOid: baseOid,
        message: title,
        additions: changeset.additions,
        deletions: changeset.deletions,
      });
      const compare = compareUrl(ctx, ctx.prHeadRef, proposed);
      return { filesChanged, branch: proposed, prUrl: compare, approvalPending: true };
    }
    assertDirectPushAllowed(ctx);
    const headOid = await getRefOid(octokit, ctx.owner, ctx.repo, ctx.prHeadRef);
    await createCommitOnBranchMutation(octokit, {
      owner: ctx.owner,
      repo: ctx.repo,
      branch: ctx.prHeadRef,
      expectedHeadOid: headOid,
      message: title,
      additions: changeset.additions,
      deletions: changeset.deletions,
    });
    return { filesChanged, branch: ctx.prHeadRef };
  }

  // Issue/dispatch: reuse the issue's existing branch when continuing, else
  // create it off the (pre-checkout) default branch.
  const branch = generateBranchName(ctx, branchSuffix);
  let branchOid: string;
  if (params.continuingBranch) {
    branchOid = await getRefOid(octokit, ctx.owner, ctx.repo, branch);
  } else {
    if (!params.baseBranch) {
      throw new Error("Issue/dispatch mode requires baseBranch to create the ref; got none.");
    }
    const baseOid = await getRefOid(octokit, ctx.owner, ctx.repo, params.baseBranch);
    await ensureRefExists(octokit, {
      owner: ctx.owner,
      repo: ctx.repo,
      branch,
      fromSha: baseOid,
    });
    branchOid = baseOid;
  }
  await createCommitOnBranchMutation(octokit, {
    owner: ctx.owner,
    repo: ctx.repo,
    branch,
    expectedHeadOid: branchOid,
    message: title,
    additions: changeset.additions,
    deletions: changeset.deletions,
  });

  const reusedPr = await reuseExistingPr(octokit, ctx, branch, {
    requireDraft: params.requireApproval,
  });
  if (reusedPr) {
    return {
      filesChanged,
      branch,
      prUrl: reusedPr.url,
      approvalPending: reusedPr.isDraft,
    };
  }

  const pr = await octokit.rest.pulls
    .create({
      owner: ctx.owner,
      repo: ctx.repo,
      head: branch,
      base: params.baseBranch ?? "main",
      title,
      body: truncateBody(buildPrBody(ctx, instruction)),
      draft: params.requireApproval,
    })
    .catch((err: unknown) => {
      throw new Error(explainGitHubError(err instanceof Error ? err.message : String(err)));
    });

  return { filesChanged, branch, prUrl: pr.data.html_url, approvalPending: params.requireApproval };
}

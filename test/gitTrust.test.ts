import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  assertDirectPushAllowed,
  captureGitTrust,
  compareUrl,
  controlPlaneGitEnv,
  flattenAgentCommits,
  listChangedFiles,
  prCheckoutSpec,
  restoreGitTrust,
  runGit,
  stripCheckoutCredentials,
} from "../src/github/ops.js";
import { assertPublishableChanges, DEFAULT_PROTECTED_PATHS } from "../src/github/protectedPaths.js";
import { computeChangeset } from "../src/github/graphqlCommit.js";
import { makeContext } from "./mockContext.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "da-git-trust-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  mkdirSync(join(root, ".deepagents"));
  writeFileSync(join(root, ".deepagents/AGENTS.md"), "guidance\n");
  writeFileSync(join(root, "a.txt"), "x\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return root;
}

/** Simulates an agent committing with its own tooling. */
function agentGit(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

const appendConfig = (root: string, text: string) =>
  writeFileSync(join(root, ".git/config"), readFileSync(join(root, ".git/config"), "utf8") + text);

describe("control-plane git hardening", () => {
  test("never runs an agent-configured fsmonitor, even before restoring config", () => {
    const root = repo();
    appendConfig(root, `[core]\n\tfsmonitor = "touch ${root}/ran; true"\n`);
    listChangedFiles(root);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  test("never runs an agent-planted hook", () => {
    const root = repo();
    const hook = join(root, ".git/hooks/pre-commit");
    mkdirSync(join(root, ".git/hooks"), { recursive: true });
    writeFileSync(hook, `#!/bin/sh\ntouch "${root}/ran"\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(root, "b.txt"), "y");
    runGit(["add", "-A"], root);
    runGit(["commit", "-m", "landing"], root);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  test("never runs a hook directory the agent pointed core.hooksPath at", () => {
    const root = repo();
    const hooks = mkdtempSync(join(tmpdir(), "da-hooks-"));
    writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\ntouch "${root}/ran"\n`);
    chmodSync(join(hooks, "pre-commit"), 0o755);
    appendConfig(root, `[core]\n\thooksPath = ${hooks}\n`);
    writeFileSync(join(root, "b.txt"), "y");
    runGit(["add", "-A"], root);
    runGit(["commit", "-m", "landing"], root);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  test("the environment excludes secrets and all user-level configuration", () => {
    const env = controlPlaneGitEnv({
      PATH: "/usr/bin",
      HOME: homedir(),
      INPUT_GITHUB_TOKEN: "secret",
      INPUT_PROVIDER_API_KEY: "secret",
      APP_PRIVATE_KEY: "secret",
      GIT_SSH_COMMAND: "evil",
      HTTPS_PROXY: "http://proxy",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HTTPS_PROXY).toBe("http://proxy");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBeDefined();
    for (const name of [
      "HOME",
      "INPUT_GITHUB_TOKEN",
      "INPUT_PROVIDER_API_KEY",
      "APP_PRIVATE_KEY",
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
  });

  test("does not read user-level configuration the agent's shell could write", () => {
    const root = repo();
    const home = mkdtempSync(join(tmpdir(), "da-home-"));
    writeFileSync(join(home, ".gitconfig"), `[core]\n\tfsmonitor = "touch ${root}/ran; true"\n`);
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      listChangedFiles(root);
    } finally {
      process.env.HOME = previous;
    }
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  test("masks the token in git failures", () => {
    const root = repo();
    expect(() =>
      runGit(["push", "https://x-access-token:SECRET@127.0.0.1:9/o/r.git", "HEAD"], root),
    ).toThrow(/^(?!.*SECRET)/s);
  });
});

describe("stripCheckoutCredentials with current actions/checkout", () => {
  /** Mirrors what actions/checkout's git-auth-helper writes. */
  function checkoutWithCredentials() {
    const root = repo();
    const temp = mkdtempSync(join(tmpdir(), "da-runner temp-"));
    const file = join(temp, "git-credentials-1234.config");
    writeFileSync(
      file,
      `[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic c2VjcmV0\n`,
    );
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    // Git matches `gitdir` against the resolved path (macOS temp dirs are symlinks).
    const gitDir = join(realpathSync(root), ".git");
    git("config", "--local", `includeIf.gitdir:${gitDir}.path`, file);
    git("config", "--local", `includeIf.gitdir:${gitDir}/worktrees/*.path`, file);
    git("config", "--local", "include.path", "/some/unrelated.config");
    return { root, temp, file, git };
  }

  test("the token is usable before stripping, which is what this guards against", () => {
    const { git } = checkoutWithCredentials();
    expect(git("config", "--get", "http.https://github.com/.extraheader")).toContain("c2VjcmV0");
  });

  test("removes the includes and the token file, keeping unrelated includes", () => {
    const { root, temp, file, git } = checkoutWithCredentials();
    stripCheckoutCredentials(root, undefined, temp);

    expect(existsSync(file)).toBe(false);
    const config = readFileSync(join(root, ".git/config"), "utf8");
    expect(config).not.toContain("git-credentials");
    expect(config).toContain("/some/unrelated.config");
    expect(() => git("config", "--get", "http.https://github.com/.extraheader")).toThrow();
  });

  test("also removes credential files no include refers to", () => {
    const root = repo();
    const temp = mkdtempSync(join(tmpdir(), "da-runner-temp-"));
    const other = join(temp, "git-credentials-other.config");
    const keep = join(temp, "deep-agent-run.json");
    writeFileSync(other, "token");
    writeFileSync(keep, "{}");
    stripCheckoutCredentials(root, undefined, temp);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(keep)).toBe(true);
  });
});

describe("restoreGitTrust", () => {
  test("removes everything the agent added to .git/config", () => {
    const root = repo();
    const snapshot = captureGitTrust(root);
    appendConfig(
      root,
      `[url "https://attacker.invalid/"]\n\tinsteadOf = https://x-access-token\n` +
        `[core]\n\tsshCommand = evil\n`,
    );
    writeFileSync(join(root, ".git/config.worktree"), "[core]\n\tfsmonitor = evil\n");
    restoreGitTrust(snapshot);

    const config = readFileSync(join(root, ".git/config"), "utf8");
    expect(config).not.toContain("attacker");
    expect(config).not.toContain("sshCommand");
    expect(existsSync(join(root, ".git/config.worktree"))).toBe(false);

    runGit(["remote", "add", "probe", "https://x-access-token:T@github.com/o/r.git"], root);
    expect(runGit(["remote", "get-url", "--push", "probe"], root)).toContain("github.com");
  });

  test("replaces a symlinked config instead of writing through it", () => {
    const root = repo();
    const snapshot = captureGitTrust(root);
    const outside = join(mkdtempSync(join(tmpdir(), "da-out-")), "target");
    writeFileSync(outside, "outside\n");
    const config = join(root, ".git/config");
    execFileSync("rm", [config]);
    symlinkSync(outside, config);
    restoreGitTrust(snapshot);
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
    expect(readFileSync(config, "utf8")).toContain("[core]");
  });

  test("refuses to land when .git was replaced with a pointer elsewhere", () => {
    const root = repo();
    const snapshot = captureGitTrust(root);
    renameSync(join(root, ".git"), join(root, "moved-git"));
    writeFileSync(join(root, ".git"), "gitdir: /tmp/evil\n");
    expect(() => restoreGitTrust(snapshot)).toThrow("replaced the .git directory");
  });

  test("refuses to land when the Git directory redirects its config", () => {
    const root = repo();
    const snapshot = captureGitTrust(root);
    writeFileSync(join(root, ".git/commondir"), "/tmp/evil\n");
    expect(() => restoreGitTrust(snapshot)).toThrow(".git/commondir");
  });
});

describe("flattenAgentCommits + protected paths", () => {
  test("a protected file committed by the agent can no longer slip past the check", () => {
    const root = repo();
    const { startSha } = captureGitTrust(root);
    writeFileSync(join(root, ".deepagents/AGENTS.md"), "hijacked\n");
    agentGit(root, "add", "-A");
    agentGit(root, "commit", "-qm", "sneak");
    writeFileSync(join(root, "b.txt"), "innocent\n");

    flattenAgentCommits(root, startSha);

    expect(runGit(["rev-parse", "HEAD"], root)).toBe(startSha);
    expect(() => assertPublishableChanges(listChangedFiles(root), DEFAULT_PROTECTED_PATHS)).toThrow(
      ".deepagents/AGENTS.md",
    );
  });

  test("keeps the agent's work when it only made ordinary commits", () => {
    const root = repo();
    const { startSha } = captureGitTrust(root);
    writeFileSync(join(root, "c.txt"), "work\n");
    agentGit(root, "add", "-A");
    agentGit(root, "commit", "-qm", "work");

    flattenAgentCommits(root, startSha);

    expect(listChangedFiles(root)).toEqual(["c.txt"]);
    expect(readFileSync(join(root, "c.txt"), "utf8")).toBe("work\n");
  });

  test("refuses a HEAD that left the starting commit, rather than publishing a revert", () => {
    const root = repo();
    agentGit(root, "checkout", "-qb", "feature");
    writeFileSync(join(root, "pr-work.txt"), "the PR\n");
    agentGit(root, "add", "-A");
    agentGit(root, "commit", "-qm", "PR work");
    const { startSha } = captureGitTrust(root);

    agentGit(root, "checkout", "-q", "-");
    expect(() => flattenAgentCommits(root, startSha)).toThrow("moved HEAD");
  });

  test("accepts commits on a new branch made from the starting commit", () => {
    const root = repo();
    const { startSha } = captureGitTrust(root);
    agentGit(root, "checkout", "-qb", "agent-branch");
    writeFileSync(join(root, "c.txt"), "work\n");
    agentGit(root, "add", "-A");
    agentGit(root, "commit", "-qm", "work");
    flattenAgentCommits(root, startSha);
    expect(listChangedFiles(root)).toEqual(["c.txt"]);
  });

  test("leaves a run with no agent commits alone", () => {
    const root = repo();
    const { startSha } = captureGitTrust(root);
    writeFileSync(join(root, "b.txt"), "y");
    flattenAgentCommits(root, startSha);
    expect(listChangedFiles(root)).toEqual(["b.txt"]);
  });

  test("a protected file in a brand-new directory is seen by its full path", () => {
    const root = repo();
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/x.yml"), "on: push\n");
    expect(listChangedFiles(root)).toEqual([".github/workflows/x.yml"]);
    expect(() => assertPublishableChanges(listChangedFiles(root), DEFAULT_PROTECTED_PATHS)).toThrow(
      ".github/workflows/x.yml",
    );
  });
});

describe("computeChangeset (verified commits)", () => {
  test("refuses a symlink leaving the repository rather than publishing its target", () => {
    const root = repo();
    const secret = join(mkdtempSync(join(tmpdir(), "da-secret-")), "secret");
    writeFileSync(secret, "TOP SECRET\n");
    symlinkSync(secret, join(root, "innocent.txt"));
    expect(() => computeChangeset(root)).toThrow("symlink leaving the repository");
  });

  test("still reads a symlink that stays inside the repository", () => {
    const root = repo();
    symlinkSync("a.txt", join(root, "link.txt"));
    const { additions } = computeChangeset(root);
    expect(additions.map((a) => a.path)).toEqual(["link.txt"]);
  });

  test("expands a new directory into its files instead of failing on it", () => {
    const root = repo();
    mkdirSync(join(root, "newdir"));
    writeFileSync(join(root, "newdir/f.txt"), "f\n");
    const { additions } = computeChangeset(root);
    expect(additions.map((a) => a.path)).toEqual(["newdir/f.txt"]);
  });
});

describe("fork PR addressing", () => {
  const fork = makeContext({
    isPR: true,
    entityNumber: 7,
    prHeadRef: "main",
    prHeadRepoFullName: "mallory/widgets",
    prBaseRepoFullName: "acme/widgets",
  });
  const same = makeContext({
    isPR: true,
    entityNumber: 7,
    prHeadRef: "feature",
    prHeadRepoFullName: "acme/widgets",
    prBaseRepoFullName: "acme/widgets",
  });

  test("a fork's head comes from refs/pull, never its branch name", () => {
    expect(prCheckoutSpec(fork)).toEqual({
      fetchRef: "refs/pull/7/head",
      localBranch: "deep-agent/pr-7-head",
    });
  });

  test("a same-repo head still uses its branch", () => {
    expect(prCheckoutSpec(same)).toEqual({ fetchRef: "feature", localBranch: "feature" });
  });

  test("refuses to push a fork's work to its same-named base branch", () => {
    expect(() => assertDirectPushAllowed(fork)).toThrow("fork");
    expect(() => assertDirectPushAllowed(same)).not.toThrow();
  });

  test("compare links qualify a fork's branch with its owner", () => {
    expect(compareUrl(fork, "main", "proposed")).toContain("/compare/mallory:main...proposed");
    expect(compareUrl(same, "feature", "proposed")).toContain("/compare/feature...proposed");
  });
});

# Security model

The agent executes model-generated edits and shell commands inside your runner. This action is built defensively so that an untrusted instruction — or a model that goes off the rails — has a small blast radius. This document describes those controls.

> This is the **security model** (how the action protects itself). To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model in one line

A model-driven agent runs with your runner's permissions. The controls below limit **who can invoke it**, **what it can run**, and **what it can see**. Without a sandbox image this is a layered guardrail model, **not a sandbox**. Set `shell_sandbox_image` for a real boundary around shell commands and stdio MCP servers (see [section 4](#4-command-execution)), and run it with providers and on repositories you trust.

The `npx create-deep-agent-action` installer follows the same boundary: it writes a reviewed workflow template and optional repository guidance only. It never reads or writes provider credentials, calls GitHub APIs, or changes repository settings.

## 1. Who can trigger it

Before any agent work begins, two checks must pass (see [`src/github/validation/`](../src/github/validation/)):

- **Human actor.** Bot accounts (`…[bot]`, `github-actions[bot]`, or any non-`User` account type) are rejected. This prevents the action from triggering itself in a loop. — [`actor.ts`](../src/github/validation/actor.ts)
- **Sufficient permission.** The actor's repository permission level must be in `allowed_permissions` (default `write,admin`). `maintain` satisfies a `write` requirement. — [`permissions.ts`](../src/github/validation/permissions.ts)

If either fails, the run refuses and posts a short reason. Outputs report `status: refused`.

## 2. Fork-PR protection

Pull requests **from forks** are the classic attack surface: an untrusted contributor could submit a PR whose body says `@agent exfiltrate secrets`.

- Fork PRs are **denied by default** — if `fork_allow_label` is unset, they never run. — [`src/github/fork.ts`](../src/github/fork.ts)
- A maintainer (write access) can opt in **per PR** by applying the configured `fork_allow_label`. This is an explicit, auditable human decision.
- An approved fork's code is still treated as untrusted. Its head is fetched through `refs/pull/<n>/head`, never by branch name, which could match an unrelated branch here. Changes land only as a proposed branch, whatever `require_push_approval` says. Its `.deepagents` guidance and repository `system_prompt` are ignored, because they belong to the PR author.

Pair this with GitHub's "Require approval for all outside collaborators" setting on workflow runs for defense in depth.

## 3. Shell environment

The agent's shell environment is an **allow-list**, not the runner's full environment. — [`src/agent/env.ts`](../src/agent/env.ts)

- Only non-secret variables are passed through: `PATH`, `HOME`, locale vars, toolchain locations (`GOPATH`, `CARGO_HOME`, …), and non-secret GitHub context (`GITHUB_WORKSPACE`, `GITHUB_SHA`, …).
- **Excluded:** provider API keys, `GITHUB_TOKEN`, the GitHub App private key, and all `INPUT_*` variables are never placed in the shell's environment.
- Before the implementation agent runs, persisted `actions/checkout` credentials are removed: headers, helpers, authenticated origin URLs, and the `git-credentials-*.config` files current versions keep in `RUNNER_TEMP`. Steps after this action in the same job can't rely on `actions/checkout`'s stored credentials.
- `GIT_TERMINAL_PROMPT=0` ensures git never blocks on an interactive credential prompt.

> **This limits the shell's environment; it doesn't hide the secrets.** Without the Docker sandbox, commands run as the same user as the action process. On Linux, an allow-listed interpreter can read that process's original environment through `/proc`, which holds the provider key and GitHub token. The guard refuses shell commands that name `/proc`, but it can't see what a `node` or `python` program does. Only the Docker sandbox puts the secrets out of reach.

## 4. Command execution

Every shell command the agent runs is screened at the shared backend boundary, including commands requested by delegated subagents. — [`src/agent/shellGuard.ts`](../src/agent/shellGuard.ts)

- **Allow-list:** only commands on `allowed_commands` (default: a common dev toolchain) may run.
- **Deny-list:** an always-on list (`curl, wget, nc, ncat, ssh, scp, sudo, su, telnet, dd, mkfs, shutdown, reboot`) is blocked even if also allow-listed — the **deny-list always wins**.
- Commands are parsed with shell quoting honored, so each `;`, `&&`, `||`, `|`, `&`, and newline-separated command is checked, and quoting can't disguise a name (`cu""rl`).
- **Refused outright:** command substitution (`$(...)`, backticks, `<(...)`), subshells and function definitions, assignments to `PATH`, `IFS`, `LD_*`, `GIT_*` and similar, shell paths into `.git` or `/proc`, programs run by `find -exec` that aren't allow-listed, and `git` operations reserved for the control plane (`commit`, `push`, `fetch`, `config`, `remote`, `rebase`, and similar, plus `git -c` and `--git-dir`).
- Each command runs in its own process group. When the run stops, for any reason, everything still running is terminated before landing begins.

The workflow owner alone configures the lists. The guard is a guardrail, and it reads command text rather than resolved values, so a path built from a variable isn't caught. Allow-listed interpreters and package runners (`node`, `python`, `npx`, …) and tools with their own execution features (`sed`'s `e` command, for example) can also still run arbitrary code and open network connections.

### Choosing where commands run

`shell_sandbox` defaults to `auto`:

| Setting | With outside input | Otherwise |
| --- | --- | --- |
| `auto`, `shell_sandbox_image` set | Docker | Docker |
| `auto`, no image | **Refused** | Runs on the runner, with a warning |
| `docker` | Docker | Docker |
| `none` | Runs on the runner | Runs on the runner |

**Outside input** means the run would execute fork PR code, or takes its instructions from an issue someone other than the actor wrote, such as a maintainer labeling an outsider's issue. An `@agent` comment doesn't count as outside input, because the comment is the authorized actor's own. Other people's comments on the thread still reach the agent as labeled data, so a public repository should set an image regardless. `none` is the workflow owner accepting the risk.

### What the Docker sandbox adds

| | On the runner | Docker |
| --- | --- | --- |
| Action secrets | Not in the shell's environment, but readable through `/proc` on Linux | Out of reach: separate PID namespace |
| Network | Whatever the runner has | None by default (`shell_sandbox_network`) |
| `.git` | Writable; restored after the run | Mounted read-only |
| Files outside the workspace | Anything the runner user can reach | Only the workspace and a scratch home |
| Lingering processes | Process group killed; `setsid` can escape | Container killed |

Each command gets a fresh container with all capabilities dropped and `no-new-privileges`, running as the runner's user. The Docker socket, runner temp directory, and action secrets aren't mounted. Provide your toolchain through `shell_sandbox_image`, pinned by digest. A run fails before any model call when Docker or the image is unavailable, and never falls back to running unsandboxed. Filesystem tools stay on the host under the permission rules below.

**Stdio MCP servers** run in containers too, from the same image, with the same hardening and a read-only workspace. Each sees only its own configured `env`, which travels through the Docker client's environment rather than its command line. `mcp_sandbox_network` defaults to `bridge`, since most servers exist to reach a service. HTTP servers are unchanged, because they already run elsewhere. A server configured with `command: docker` keeps its own flags, which then decide its isolation; the action logs a warning. Without the Docker sandbox, stdio servers run on the runner, with the same `/proc` exposure as the shell.

### Treating the checkout as tampered

The control plane assumes the agent may have altered the checkout, because Git configuration can run programs and redirect pushes. — [`src/github/ops.ts`](../src/github/ops.ts)

- Filesystem tools can't read or write `.git`. That rule precedes all custom permissions, and applies to subagents.
- Control-plane Git ignores user and system configuration, disables hooks and `fsmonitor`, resolves the `git` binary before the agent starts, and receives no secrets in its environment.
- Landing first terminates the shell, then restores `.git/config` from a snapshot taken before the agent ran, and refuses to continue if `.git` was replaced or redirected. Any commits the agent made are folded into a single control-plane commit, so the protected-path check sees everything since the agent started. Landing is refused if HEAD no longer descends from the starting commit.
- Verified commits refuse a symlink leaving the repository, instead of publishing its target's contents.

**Remaining gap without the Docker sandbox:** a process that escapes its process group with `setsid` could rewrite `.git/config` between the restore and the push. Use `docker` where that matters.

## 5. Human-in-the-loop approval gate

Changes are approval-gated by default. — [`src/github/ops.ts`](../src/github/ops.ts)

Keep `require_push_approval: true` (the default):

- **Issue / dispatch mode:** the change opens as a **draft PR** instead of a ready PR.
- **PR mode:** the change is pushed to a **proposed branch** (`deep-agent/proposed/<n>-<run>`) and the comment includes a **compare link** — nothing is pushed to the PR branch until a human acts.

See [examples/approval-gate.yml](../examples/approval-gate.yml).

## 6. Repository guidance and deepagents policy

The action loads only repository-local `.deepagents/AGENTS.md` and `.deepagents/skills/` sources. Issue, PR, and comment text is supplied separately as untrusted task data; it is not merged into repository guidance.

- `AGENTS.md` is read as always-on context, not as a place to store credentials or task state.
- Deepagents filesystem writes under `/.deepagents/**` are denied before custom permission rules are applied. Because filesystem rules do not constrain shell execution, the control plane also refuses to publish `.deepagents/**`, deep-agent config paths, and `.github/workflows/**` after either Git landing path.
- Harness artifacts (evicted tool results, summarized history) are routed to a temporary directory outside the checkout, so they can't end up in a commit.
- `harness_profile`, `filesystem_permissions`, and `subagents` inputs are strict-validated and workflow-owned. Specialist subagents may only add filesystem deny rules, use repository-local skills, and select an explicit allow-list of MCP tools already loaded for the action.
- The filesystem permission rules do not sandbox shell execution. Keep using the command allow-list, deny-list, and protected paths, and use `shell_sandbox: docker` for hard process isolation.

Review mode has a narrower boundary: it exposes only read/search tools and has no shell backend at all. Findings come back as a schema-validated structured response, and a run that produces none fails visibly rather than posting an empty review. “Review and fix” suggestions are applied by the control plane only to paths returned by GitHub's changed-files API that resolve to contained, non-symlink regular files; rejected suggestions remain review comments.

## 7. Scoped tokens & least privilege

- By default the action uses the workflow's `GITHUB_TOKEN`. Scope it with the `permissions:` block — grant only `contents`, `pull-requests`, and `issues` write as needed.
- For a stronger identity (and to let the agent's PRs trigger CI), configure a **GitHub App**. The action mints a **short-lived, installation-scoped** token via [`@octokit/auth-app`](https://github.com/octokit/auth-app.js). — [`src/github/auth.ts`](../src/github/auth.ts), [examples/github-app.yml](../examples/github-app.yml).

## 8. Auditability

Every run is recorded:

- A **sticky comment** shows the plan, progress, outcome, and token/cost estimate.
- A **job summary** captures the same in the Actions UI.
- `result_json` output and the **`deep-agent-run` artifact** contain the full machine-readable run record (plan, files changed, tokens, cost, status).

## Hardening checklist

- [ ] Keep `permissions:` minimal in the workflow.
- [ ] Leave `fork_allow_label` unset unless you actively triage fork PRs.
- [ ] Trim `allowed_commands` to what your project actually needs.
- [ ] Set a digest-pinned `shell_sandbox_image`, especially on public repositories or any repository that accepts outside instructions.
- [ ] Keep `require_push_approval: true` unless direct branch updates are explicitly intended.
- [ ] Add `protected_paths` for release configuration or other repository-specific control-plane files.
- [ ] Store provider keys as repository/organization **secrets**, never in the workflow file.
- [ ] Prefer a GitHub App with least-privilege installation scopes over a broad PAT.

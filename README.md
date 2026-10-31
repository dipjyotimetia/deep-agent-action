# Deep Agent Action

> An AI coding agent for your GitHub issues and pull requests — mention `@agent`, and it plans, edits, runs your toolchain, and opens a PR. Powered by the [Deep Agents](https://www.npmjs.com/package/deepagents) JS harness, running in-process on your runner.

[![CI](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/ci.yml/badge.svg)](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/ci.yml)
[![E2E](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/e2e.yml/badge.svg)](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/e2e.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/built%20with-Bun-000000.svg?logo=bun)](https://bun.sh)

Comment `@agent fix the failing test` on an issue and get a pull request back. Comment `@agent review` on a PR and get an inline code review. No hosted service, no extra infrastructure — the agent runs entirely inside your GitHub Actions runner, using a model provider of your choice.

---

## Table of contents

- [Why this action](#why-this-action)
- [Features](#features)
- [Set up with npx](#set-up-with-npx)
- [Quickstart](#quickstart)
- [Demo](#demo)
- [How it works](#how-it-works)
- [Usage modes](#usage-modes)
- [Models & providers](#models--providers)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Per-repo configuration](#per-repo-configuration)
- [Project Wiki](#project-wiki)
- [Security](#security)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Versioning](#versioning)
- [Contributing](#contributing)
- [License](#license)

## Why this action

|                   | Deep Agent Action                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup**         | Copy one workflow, add one secret. No app install wizard, no hosted backend.                                                                                                     |
| **Where it runs** | In-process on your runner — your code never leaves your CI.                                                                                                                      |
| **Models**        | 8 providers: Anthropic, OpenAI, Azure OpenAI, Google Gemini, OpenRouter, any OpenAI-compatible endpoint, AWS Bedrock, GCP Vertex AI.                                             |
| **Safety**        | Command allow/deny guardrails, curated shell environment, optional Docker sandbox, fork-PR protection, permission gating, approval-gated landing by default, protected paths, and optional cost/token spend caps. |
| **Feedback**      | A single sticky comment shows a live plan, progress, the PR link, and token/cost estimates.                                                                                      |

## Features

- 🤖 **In-runner agent** — plans, reads and edits files, runs your toolchain, commits, and opens a PR. No external service.
- 💬 **`@agent` triggers** — works from issue comments, PR comments, PR review comments, new issues, and new PRs. Manual runs via `workflow_dispatch` too.
- 🔌 **8 model providers** — Anthropic, OpenAI, Azure, Google Gemini, OpenRouter, OpenAI-compatible (Groq, xAI, DeepSeek, Together, Ollama, vLLM, …), AWS Bedrock, GCP Vertex AI.
- 🔍 **Code review mode** — `@agent review` reads the PR diff and posts inline review comments. `@agent review and fix` also applies clean single-line suggestions directly and lands them as a commit.
- 🏷️ **Label/assignee triggers** — `auto_run_label` / `auto_run_assignee` run the agent without a trigger-phrase match; combine with `on: schedule` + `prompt` for unattended maintenance runs (see [`examples/scheduled-maintenance.yml`](examples/scheduled-maintenance.yml)).
- 🔁 **Issue/PR continuity** — a follow-up mention on the same issue reuses the same branch and PR instead of opening a new one each time. A plain `@agent continue` (or `resume`) picks up an incomplete plan where it left off.
- ✅ **Verified commits** — optional `verified_commits: true` lands changes via the GitHub App's `createCommitOnBranch` mutation so they show as "Verified".
- 🧭 **Issue-triage lifecycle** (opt-in) — `enable_triage: true` uses visible labels to request reproduction details, re-triage new evidence, and propose a draft fix. External contributors receive safe labels/comments only; a permitted maintainer approves any coding run with `triage: run`.
- ✋ **Human-in-the-loop gate** — optionally require approval before changes land (draft PR or proposed branch + compare link).
- 📌 **Sticky progress comment** — one comment, updated in place, with a live checklist, summary, PR link, and token/cost estimate.
- 💰 **Cost reporting** — token usage and an estimated USD cost surfaced in the comment, job summary, and machine-readable output.
- 🛑 **Spend caps** — optional `max_cost_usd` / `max_total_tokens` ceilings stop a run the moment it crosses the limit (counting subagent spend too) and land the partial work as a draft for review.
- 🧠 **Cross-run memory** — a compact history of prior `@agent` turns on the same issue/PR is carried forward as context on the next mention. No backend; stored in the sticky comment.
- 🧩 **Deepagents memory and skills** — repository-local `.deepagents/AGENTS.md` is loaded as read-only guidance, while `.deepagents/skills/` exposes progressive-disclosure `SKILL.md` workflows to the agent.
- 🧑‍🔬 **Specialist subagents** — opt into named synchronous specialists for focused work, with static model selection, scoped MCP tools, repository skills, structured findings, and the same approval controls.
- 🛡️ **Shell guardrails** — an allow-list and an always-on deny-list for shell commands, a curated environment, and an optional Docker sandbox.
- 🍴 **Fork-PR protection** — fork PRs are denied by default; maintainers opt in per-PR with a label.
- 🧰 **MCP tools** — connect Model Context Protocol servers to extend what the agent can do.
- 🚀 **Zero-config** — sensible defaults for everything; the only required secret is your model provider key.

## Set up with npx

From the root of any Git repository, run:

```sh
npx create-deep-agent-action
```

The creator writes a least-privilege `.github/workflows/deep-agent.yml`, pinned to an immutable action commit, and a minimal read-only `.deepagents/AGENTS.md` guidance file. It preserves existing files unless you explicitly pass `--force`; it never writes provider keys or changes GitHub repository settings.

Add `PROVIDER_API_KEY` in **Settings → Secrets and variables → Actions**, then enable **Allow GitHub Actions to create and approve pull requests** under **Settings → Actions → General** if you use the default `GITHUB_TOKEN`. Use `npx create-deep-agent-action --help` for non-interactive model, trigger, target-directory, and guidance options.

## Quickstart

**1. Add the workflow** at `.github/workflows/agent.yml`:

```yaml
name: Deep Agent

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  workflow_dispatch:
    inputs:
      prompt:
        description: "Instruction for the agent"
        required: true

permissions:
  contents: write
  pull-requests: write
  issues: write

# One agent run per issue/PR thread at a time: simultaneous @agent mentions
# queue instead of racing the sticky tracking comment (and its memory block).
# cancel-in-progress stays false so an in-flight run finishes and lands its work.
concurrency:
  group: deep-agent-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false

jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: dipjyotimetia/deep-agent-action@main
        with:
          model: "claude-sonnet-5"
          prompt: ${{ github.event.inputs.prompt }}
        env:
          PROVIDER_API_KEY: ${{ secrets.PROVIDER_API_KEY }}
```

**2. Add one secret.** In **Settings → Secrets and variables → Actions**, add `PROVIDER_API_KEY` with your model provider's API key (e.g. an Anthropic key for the default model).

**3. Use it.** Open an issue and comment:

```
@agent add input validation to the signup form and a test for it
```

The agent posts a tracking comment, works through a plan, and opens a pull request with the change.

> [!TIP]
> That's the whole setup. Everything else on this page is optional tuning. For a copy-paste-ready file with inline comments, see [`examples/agent.yml`](examples/agent.yml).

## Demo

Want to see it work before wiring it into your repo? Run the **Demo** workflow (**Actions → Demo → Run workflow**) — it runs the agent on a visible task and opens a real pull request you can browse. The [E2E badge](https://github.com/dipjyotimetia/deep-agent-action/actions/workflows/e2e.yml) above also reflects a nightly live run that exercises the implement and approval-gate modes against this repo.

See [docs/demo.md](docs/demo.md) for a walkthrough, sample output, and the `result_json` shape.

## How it works

```
GitHub event (comment / issue / PR / dispatch)
        │
        ▼
1. Route  ─ is there a trigger phrase or explicit prompt? ── no ─▶ no-op (exit)
        │ yes
        ▼
2. Authorize ─ human actor? sufficient permission? fork allowed? ── no ─▶ refuse (comment)
        │ yes
        ▼
3. Acknowledge ─ 👀 reaction + create/reuse the sticky tracking comment
        │
        ▼
4. Run the agent
        ├─ agent mode   → edit files, run toolchain, commit
        └─ review mode  → read the PR diff, collect findings
        │
        ▼
5. Land the result
        ├─ open a PR / push to the PR branch  (or a draft PR / proposed branch if approval is required)
        └─ post inline review comments
        │
        ▼
6. Finalize ─ update the sticky comment (status, plan, activity, PR link, tokens/cost) + emit outputs + audit artifact
```

The agent only acts when it is both **triggered** (a mention or explicit prompt) and **authorized** (a human collaborator with write/admin access). Secrets are never exposed to the agent's shell. See the [security model](docs/security.md) for the full picture.

## Usage modes

| You want to…       | Where                            | Comment                                                        |
| ------------------ | -------------------------------- | -------------------------------------------------------------- |
| Implement a change | An **issue**                     | `@agent implement X` → opens a PR                              |
| Fix / extend a PR  | A **pull request**               | `@agent address the review feedback` → pushes to the PR branch |
| Get a code review  | A **pull request**               | `@agent review` → posts inline comments                        |
| Run unattended     | **Actions tab** → _Run workflow_ | provide a `prompt` input (no mention needed)                   |

The agent enters **review mode** automatically when the instruction starts with `review` on a pull request; otherwise it implements. Review mode can read and search the checkout but has no shell or repository-edit tool. Its JSON handoff is written to isolated temporary storage outside the repository. When suggestions are applied, only non-symlink regular files from GitHub's changed-file list are eligible; unsafe findings remain comments.

## Models & providers

Set the `model` input (default `claude-sonnet-5`). A bare model name infers the provider (`claude…` → Anthropic, `gpt…`/`o…` → OpenAI, `gemini…` → Google); otherwise prefix it with `provider:`.

| Provider          | Example `model`                                     | Auth                                         |
| ----------------- | --------------------------------------------------- | -------------------------------------------- |
| Anthropic         | `claude-sonnet-5`                                   | `PROVIDER_API_KEY` (or `ANTHROPIC_API_KEY`)  |
| OpenAI            | `openai:gpt-5`                                      | `PROVIDER_API_KEY` (or `OPENAI_API_KEY`)     |
| Azure OpenAI      | `azure:<deployment>`                                | `AZURE_OPENAI_*` env vars                    |
| Google Gemini     | `google:gemini-2.5-pro`                             | `PROVIDER_API_KEY` (or `GOOGLE_API_KEY`)     |
| OpenRouter        | `openrouter:openai/gpt-4o`                          | `PROVIDER_API_KEY` (or `OPENROUTER_API_KEY`) |
| OpenAI-compatible | `openai-compatible:llama-3.1-70b` + `base_url`      | `PROVIDER_API_KEY`                           |
| AWS Bedrock       | `bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0` | AWS env chain (`AWS_REGION`, …)              |
| GCP Vertex AI     | `vertexai:gemini-2.5-pro`                           | ADC / `GOOGLE_APPLICATION_CREDENTIALS`       |

Full per-provider setup (env vars, regions, credentials) is in [docs/providers.md](docs/providers.md).

## Inputs

All inputs are optional.

| Input                          | Description                                                                                                                                                                                                                 | Default                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `trigger_phrase`               | Phrase that triggers the agent in issue/PR/comment bodies.                                                                                                                                                                  | `@agent`                |
| `prompt`                       | Explicit instruction (e.g. for `workflow_dispatch`); bypasses the trigger phrase.                                                                                                                                           | —                       |
| `model`                        | Model id, optionally provider-prefixed. See [Models & providers](#models--providers).                                                                                                                                       | `claude-sonnet-5`       |
| `base_url`                     | Endpoint URL for the `openai-compatible` provider.                                                                                                                                                                          | —                       |
| `mcp_config`                   | MCP servers JSON: `{ "mcpServers": { name: { command, args, env } \| { url } } }`.                                                                                                                                          | —                       |
| `harness_profile`              | Strict deepagents harness-profile JSON (`systemPromptSuffix`, tool overrides, excluded tools/middleware, or general-purpose subagent settings).                                                                             | —                       |
| `filesystem_permissions`       | Strict deepagents filesystem-rule JSON with `operations`, absolute glob `paths`, and optional `mode`. Built-in filesystem writes to `.deepagents/` stay denied.                                                             | —                       |
| `subagents`                    | Strict JSON specialist declarations. Each requires `name`, `description`, `systemPrompt`, and an explicit MCP-tool allow-list; optional model, repository skills, deny-only filesystem rules, and `findings` response mode. | —                       |
| `allowed_permissions`          | Comma-separated repo permission levels allowed to trigger the agent.                                                                                                                                                        | `write,admin`           |
| `allowed_commands`             | Comma/newline-separated allow-list of shell commands.                                                                                                                                                                       | a common dev toolchain¹ |
| `denied_commands`              | Extra command names to block (merged with the built-in deny-list).                                                                                                                                                          | —                       |
| `fork_allow_label`             | Label a write-access user applies to authorize the agent on a fork PR. If unset, fork PRs never run.                                                                                                                        | —                       |
| `auto_run_label`               | Label that, when applied to an issue, runs the agent without a trigger-phrase match.                                                                                                                                        | —                       |
| `auto_run_assignee`            | GitHub username that, when assigned to an issue, runs the agent without a trigger-phrase match.                                                                                                                             | —                       |
| `auto_run_default_instruction` | Fallback instruction for an auto-run event when the issue has no usable title/body text.                                                                                                                                    | —                       |
| `shell_timeout_seconds`        | Max seconds for a single shell command.                                                                                                                                                                                     | `600`                   |
| `shell_sandbox`                | Where shell commands run: `none` (on the runner) or `docker` (throwaway container, no access to action secrets).                                                                                                            | `none`                  |
| `shell_sandbox_image`          | Container image providing your toolchain, pinned by digest. Required with `docker`.                                                                                                                                         | —                       |
| `shell_sandbox_network`        | Container network: `none` or `bridge`.                                                                                                                                                                                      | `none`                  |
| `comment_debounce_ms`          | Minimum interval between tracking-comment progress edits.                                                                                                                                                                   | `8000`                  |
| `provider_api_key`             | Model provider API key. Also read from `PROVIDER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `OPENROUTER_API_KEY`.                                                                               | —                       |
| `app_id`                       | GitHub App id used to mint a scoped installation token. Also read from `APP_ID`.                                                                                                                                            | —                       |
| `app_private_key`              | GitHub App private key (PEM). Also read from `APP_PRIVATE_KEY`.                                                                                                                                                             | —                       |
| `github_token`                 | Token for GitHub API/git operations.                                                                                                                                                                                        | `${{ github.token }}`   |
| `require_push_approval`        | Gate landing of changes behind human review (draft PR / proposed branch).                                                                                                                                                   | `true`                  |
| `protected_paths`              | Extra repository-relative globs the agent may modify during a run but can never publish. Agent guidance, repo config paths, and `.github/workflows` are always protected.                                                                         | —                       |
| `verified_commits`             | Land via the GitHub App's `createCommitOnBranch` GraphQL mutation so commits show as "Verified". Requires `app_id`/`app_private_key`.                                                                                       | `false`                 |
| `enable_triage`                | Enable the label-backed lifecycle for unmentioned issues.                                                                                                                                                                    | `false`                 |
| `triage_label_*`               | Names for visible lifecycle labels, including needs-reproduction, needs-maintainer, and fix-proposed. Labels must already exist in the target repository.                                                                      | `triage: …`             |
| `triage_run_label`             | Maintainer-applied label that authorizes an agentic triage run for an external issue.                                                                                                                                       | `triage: run`           |
| `triage_bot_logins`            | Additional bot logins whose comments never cause re-triage.                                                                                                                                                                 | —                       |
| `triage_max_failed_attempts`   | Bounded automatic retries after unexpected triage failures.                                                                                                                                                                 | `3`                     |
| `triage_model`                 | Model used for lifecycle classification.                                                                                                                                                                                     | `model`                 |
| `max_cost_usd`                 | Abort the run once estimated spend reaches this many USD; partial work lands as a draft. Requires a known model price — pair with `max_total_tokens` for unpriced models.                                                   | — (no cap)              |
| `max_total_tokens`             | Abort once cumulative billed tokens (input + output) reach this many; partial work lands as a draft. Re-counted each model call as context grows, so set it generously.                                                     | — (no cap)              |
| `max_runtime_minutes`          | Abort the agent once it has run this many minutes; partial work lands as a draft (like a budget stop). A job-level `timeout-minutes` still applies but kills the run without landing anything.                              | — (no cap)              |
| `recursion_limit`              | Max agent super-steps per run. Raise for long multi-step tasks that reach the recursion ceiling.                                                                                                                            | `150`                   |
| `max_repeated_tool_calls`      | Stop a no-progress loop when the same tool call repeats without a todo update.                                                                                                                                              | `8`                     |

¹ Default `allowed_commands`: `git, ls, cat, mkdir, touch, cp, mv, node, npm, npx, pnpm, yarn, bun, python, python3, pip, pytest, go, make, cargo, rustc, sed, grep, find, echo`. Always-on deny-list: `curl, wget, nc, ncat, ssh, scp, sudo, su, telnet, dd, mkfs, shutdown, reboot`. See [docs/configuration.md](docs/configuration.md).

> [!IMPORTANT]
> The action opens pull requests with the `GITHUB_TOKEN`. For that to work, enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"** (otherwise you'll see _"GitHub Actions is not permitted to create or approve pull requests"_). Alternatively, use a GitHub App (`app_id` + `app_private_key`), which doesn't require this setting.

> [!NOTE]
> PRs opened with the default `GITHUB_TOKEN` also do **not** trigger your other CI workflows. If you need the agent's PRs to run CI, configure a GitHub App (`app_id` + `app_private_key`). See [examples/github-app.yml](examples/github-app.yml).

## Outputs

| Output           | Description                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `status`         | Run outcome: `success` \| `skipped` \| `refused` \| `failed`.                                               |
| `pr_url`         | URL of the opened pull request (or compare link), if any.                                                   |
| `branch`         | Branch the agent pushed to, if any.                                                                         |
| `budget_stopped` | `true` when a cost/token cap stopped the run early (partial work opened for review).                        |
| `timed_out`      | `true` when `max_runtime_minutes` stopped the run early (partial work opened for review).                   |
| `stalled`        | `true` when a no-progress loop or recursion ceiling stopped the run early (partial work opened for review). |
| `audit_artifact` | Invocation-unique name of the uploaded audit-record artifact.                                               |
| `result_json`    | Machine-readable run record (plan, files changed, tokens, cost, outcome).                                   |

Every run also writes a job summary and uploads an invocation-scoped `deep-agent-run-<uuid>` artifact as an audit record. Its exact name is exposed through the `audit_artifact` output, so parallel jobs, matrix jobs, and repeated action steps cannot replace each other's records.

## Per-repo configuration

Commit an optional `.github/deep-agent.yml` to add repository guidance without giving repository content authority over execution policy:

```yaml
# .github/deep-agent.yml
system_prompt: |
  This is a TypeScript monorepo managed with pnpm. Always co-locate tests with
  the code they cover, and never edit files under generated/.
```

All execution, landing, budget, filesystem, MCP, and subagent controls belong in the invoking workflow. Full field reference in [docs/configuration.md](docs/configuration.md).

## Project Wiki

The repository's detailed code documentation lives in [`openwiki/`](openwiki/) and is published to the [GitHub Wiki](https://github.com/dipjyotimetia/deep-agent-action/wiki) after review.

A weekly workflow runs OpenWiki through OpenRouter and maintains one `openwiki/update` pull request. Merging reviewed documentation into `main` invokes the immutable [`openwiki-github-wiki-action`](https://github.com/dipjyotimetia/openwiki-github-wiki-action) release, which treats `openwiki/` as canonical and replaces the generated Wiki pages. The publisher never runs a model or publishes an unreviewed update.

Both workflows mint short-lived credentials from the dedicated OpenWiki Publisher GitHub App. Configure `OPENWIKI_APP_CLIENT_ID` as a repository variable and `OPENWIKI_APP_PRIVATE_KEY` as a repository secret; the App needs **Contents: Read and write** and **Pull requests: Read and write** for this combined workflow. Create the Wiki's first `Home` page in GitHub once before the first publication.

## Security

The agent runs untrusted, model-generated commands, so the action is defensive by default:

- **Permission gating** — only human collaborators with `write`/`admin` (configurable) can trigger it; bot accounts are ignored to prevent loops.
- **Fork-PR protection** — fork PRs are denied unless a maintainer applies the `fork_allow_label`.
- **Curated shell environment** — provider keys and `GITHUB_TOKEN` are never placed in the shell's environment. Set `shell_sandbox: docker` to put them out of reach entirely.
- **Command guardrails** — an allow-list plus an always-on deny-list (network/privilege tools are blocked even if allow-listed), enforced at the shared backend for the main agent and delegated subagents.
- **Human-approval gate** — landing is approval-gated by default; set `require_push_approval: false` only for deliberate direct updates.
- **Tamper-resistant landing** — before committing, the control plane stops everything the agent started, restores Git configuration, and folds any agent commits into one reviewed change.
- **Repository guidance boundary** — only `.deepagents/AGENTS.md` and `.deepagents/skills/` are loaded by deepagents; their built-in filesystem writes are denied, protected paths cannot be published, and issue/PR text remains separate untrusted data.

By default this is a guardrail model, not a sandbox: allowed commands execute directly on the runner. Use `shell_sandbox: docker` for real isolation, and run it on the providers and repos you trust. See [docs/security.md](docs/security.md) for the full threat model, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Examples

Ready-to-copy workflows live in [`examples/`](examples/):

| Example                                                           | What it shows                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`agent.yml`](examples/agent.yml)                                 | The all-in-one starting point.                                       |
| [`review.yml`](examples/review.yml)                               | Code-review-only setup for pull requests.                            |
| [`approval-gate.yml`](examples/approval-gate.yml)                 | Require human approval before changes land.                          |
| [`multi-provider.yml`](examples/multi-provider.yml)               | OpenAI, Bedrock, Vertex, OpenRouter, and OpenAI-compatible variants. |
| [`mcp-tools.yml`](examples/mcp-tools.yml)                         | Extend the agent with MCP servers.                                   |
| [`github-app.yml`](examples/github-app.yml)                       | Use a GitHub App so the agent's PRs trigger your CI.                 |
| [`issue-automation.yml`](examples/issue-automation.yml)           | Turn issue comments/labels into PRs.                                 |
| [`scheduled-maintenance.yml`](examples/scheduled-maintenance.yml) | Unattended `schedule`-triggered runs (e.g. dependency upgrades).     |

## Troubleshooting

A few common cases — full guide in [docs/troubleshooting.md](docs/troubleshooting.md).

- **Nothing happened.** Check the workflow listens to the event you used (e.g. `issue_comment`), the comment contains the exact trigger phrase at a word boundary, and the run wasn't a no-op in the Actions log.
- **"Request not authorized."** The actor needs `write`/`admin` access (per `allowed_permissions`), or it's a fork PR without the `fork_allow_label`, or the actor is a bot.
- **The agent's PR didn't run my CI.** Expected with the default `GITHUB_TOKEN` — switch to a GitHub App (see [examples/github-app.yml](examples/github-app.yml)).
- **Cost shows tokens but no `$`.** The model name isn't in the estimate table; usage is still reported. See [`src/agent/cost.ts`](src/agent/cost.ts).

## Versioning

### v2 migration

- Move every execution/security setting from `.github/deep-agent.yml` into the calling workflow; the repository file now supports only `system_prompt`.
- Replace global `apply_suggestions: true` with an explicit `@agent review and fix` request.
- Remove `interrupt_on` and the reserved bridge inputs; an ephemeral runner cannot provide durable tool approval or hosted execution.
- Review any automation that expected direct landing: `require_push_approval` now defaults to `true`.
- The agent can no longer change `.github/workflows/**` through this action, run `git commit`/`push`/`config`, or use `$(...)` in shell commands. Its commits are folded into one control-plane commit.
- Fork PRs approved with `fork_allow_label` always land as a proposed branch, and ignore the fork's `.deepagents` guidance.
- A review run that doesn't return a result now fails instead of posting an empty review.
- `actions/checkout` credentials are removed for the rest of the job, so later steps that need them must authenticate themselves.

Pin to a ref you trust. `@main` tracks the latest:

```yaml
- uses: dipjyotimetia/deep-agent-action@main
```

For reproducible builds, pin to a commit SHA:

```yaml
- uses: dipjyotimetia/deep-agent-action@<commit-sha>
```

## Contributing

Contributions are welcome. The action is TypeScript run directly on [Bun](https://bun.sh) — no build/bundle step. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, project layout, and how to add a provider. For an audit of the feature surface — strengths, recently closed gaps, and the roadmap — see [docs/feature-review.md](docs/feature-review.md).

## License

[MIT](LICENSE) © Dipjyoti Metia

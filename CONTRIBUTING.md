# Contributing

Thanks for your interest in improving Deep Agent Action! This guide covers the dev setup, the project layout, and how to make common changes.

## Prerequisites

- [Bun](https://bun.sh) **1.4.0** (the version [`action.yml`](action.yml) pins; CI and E2E use the same one). Install with `curl -fsSL https://bun.sh/install | bash`.
- A GitHub account. For end-to-end testing, a sandbox repo where you can run the action.

There is **no build/bundle step** — the action runs `src/index.ts` directly via `bun run`. You won't find or commit a `dist/` bundle.

## Setup

```bash
git clone https://github.com/dipjyotimetia/deep-agent-action.git
cd deep-agent-action
bun install
```

## Dev loop

Run these before opening a PR — CI runs the same checks ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)):

```bash
bun run typecheck     # tsc --noEmit
bun test              # unit tests (test/*.test.ts)
bun run format:check  # prettier --check
bun run smoke         # loads every provider package to catch bundling/import errors
```

Auto-fix formatting with `bun run format`.

The **smoke** check (`DEEP_AGENT_SMOKE=1 bun run src/index.ts`) instantiates all provider models and exits. It catches import/packaging issues that the source-run tests miss, so run it after touching dependencies or [`src/agent/model.ts`](src/agent/model.ts).

## Publishing the setup creator

`packages/create-deep-agent-action` is an independently publishable, Node-only package. Set an npm automation token as the protected `NPM_TOKEN` repository secret, then update its version and push a matching `create-deep-agent-action-v*` tag (or use the protected **Publish creator** workflow) to publish it with npm provenance. The root action package remains private and is never published by that workflow.

## Project layout

```
action.yml                 # Action metadata: inputs, outputs, composite run steps
src/
  index.ts                 # Entry point: route event → authorize → hand off to a flow
  flows/
    implement.ts           # Edit files, then land them
    review.ts              # Review a PR and post findings
    shared.ts              # Streaming, comment mirroring, landing order
  smoke.ts                 # Constructs every provider model without network calls
  config.ts                # Parse/normalize inputs; default allow/deny lists
  config/repoConfig.ts     # Optional .github/deep-agent.yml loader
  outputs.ts               # Action outputs, job summary, audit artifact
  types.ts                 # Shared types
  agent/
    model.ts               # Multi-provider model factory  ← add providers here
    createAgent.ts         # Assemble the Deep Agent (memory/skills + policy + guardrails + tools)
    policy.ts              # Deepagents sources, profile, and the permission floor
    prompt.ts              # System/user prompts (implement & review)
    stream.ts              # Run the agent, mirror progress to the comment
    shellGuard.ts          # Shared backend command allow/deny enforcement and audit
    shellExec.ts           # Runs approved commands: local process groups or Docker
    env.ts                 # Shell environment allow-list
    mcp.ts                 # Load MCP servers
    cost.ts                # Token → USD estimate
  github/
    context.ts             # Parse the event payload
    client.ts / auth.ts    # Octokit client + token / GitHub App auth
    comments.ts            # Sticky tracking comment
    review.ts              # Review schema, suggestions, and posting
    ops.ts                 # Hardened git: trust restore, commit, push, open PR
    fork.ts                # Fork-PR gating
    validation/            # trigger / actor / permission checks
  modes/detector.ts        # Route event → agent | review | noop
test/                      # One *.test.ts per module, plus agentContract (real deepagents graph)
examples/                  # Consumer workflows
docs/                      # Configuration, providers, security, troubleshooting
scripts/e2e/               # Live E2E harness helpers (result validator)
```

## Testing

Two layers:

**Unit tests** (`bun test`) — fast, deterministic, no network. They cover the pure logic module by module: routing, trigger parsing, permission/actor/fork gating, cost estimation, comment rendering, and the E2E harness helpers in `scripts/e2e/`. `test/agentContract.test.ts` drives the real deepagents graph with a scripted model, so upstream behavior changes fail here. These run in [CI](.github/workflows/ci.yml) on every push. Run a subset with `bun test test/<file>.test.ts`. To include the live Docker sandbox tests, set `DEEP_AGENT_DOCKER_TEST_IMAGE=alpine:3.20` and `DEEP_AGENT_DOCKER_TEST_NODE_IMAGE=node:22-alpine` with a Docker daemon running.

**Live E2E** ([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml)) — runs the action _as shipped_ against this repository with a real model and the real GitHub API, then cleans up. It's the only layer that exercises the full `src/index.ts` orchestration end to end. Jobs:

| Job             | Verifies                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `implement`     | `workflow_dispatch` + prompt opens a real PR; `status=success`; `result_json` and the invocation-scoped audit artifact are well-formed. |
| `approval-gate` | `require_push_approval: true` lands the change as a **draft** PR with `approvalPending`.                                                |
| `budget-cap`    | A tiny `max_total_tokens` aborts the run mid-flight; `budget_stopped=true`, and any partial work lands as a draft PR.                   |

How to run: **Actions → E2E → Run workflow** (it also runs nightly). It needs the `PROVIDER_API_KEY` repository secret (defaults to `openai:gpt-4o-mini`); when the secret is absent every job **skips cleanly** rather than failing. Each run makes a few tiny model calls — cents. The harness helpers are pure and unit-tested, so you can validate their logic locally without a live run:

```bash
echo '{"status":"success","mode":"agent","model":"x","plan":[],"toolCalls":[],"filesChanged":[]}' \
  | bun run scripts/e2e/assert-result.ts                      # validates a result_json
```

**Live E2E — dogfood harness** ([`.github/workflows/e2e-live-events.yml`](.github/workflows/e2e-live-events.yml) + [`e2e-live-orchestrator.yml`](.github/workflows/e2e-live-orchestrator.yml)) — the E2E jobs above only ever exercise `workflow_dispatch`. Looking at `src/modes/detector.ts::detectMode`, an explicit `prompt` short-circuits straight to `"agent"` mode for _any_ event name, so `workflow_dispatch` structurally can never reach trigger-phrase detection, review mode, label/assignee auto-run, resume/continue, or the thread-context fetch (`src/github/thread.ts`) — all of which only run on a real `ctx.entityNumber` from a real issue/PR event. GitHub also won't let a runner fake `GITHUB_EVENT_*`, so the only way to exercise these is with **real GitHub events**: `e2e-live-orchestrator.yml` (`workflow_dispatch` only, no schedule) creates real synthetic issues/PRs/comments in this repo via `scripts/e2e/live/scenario-*.ts`, and `e2e-live-events.yml` — a real reactive consumer workflow, isolated behind the dedicated `@e2e-agent` trigger phrase and `e2e-agent-autorun`/`e2e-resume-cap` labels so it can never collide with genuine repo conversation — reacts to them with `uses: ./`. Four scenarios:

| Scenario         | Verifies                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread-context` | Regression test for the thread-context fix: a vague issue, the real detail in a follow-up comment, then a bare mention — asserts the resulting PR actually contains what only the follow-up comment asked for. |
| `review`         | Review mode end to end (no live coverage otherwise): a PR with a deliberate bug, `@e2e-agent review`, asserts a PR review gets posted.                                                                         |
| `auto-run`       | The `auto_run_label` bypass: an issue with **no** trigger phrase anywhere, labeled `e2e-agent-autorun`, asserts the agent still ran.                                                                           |
| `resume`         | `isResumeRequest`: a capped `max_total_tokens` run stops mid-plan, then `@e2e-agent continue` asserts the new run's plan carries over the prior open todos.                                                    |

Two things to know before running it:

- **Identity.** `src/github/validation/actor.ts::checkActorIsHuman` rejects bot-authored actors — a real anti-loop protection, not weakened for this harness. The orchestrator's synthetic issues/comments must therefore be created with a real maintainer's PAT, not the default `GITHUB_TOKEN`. Add it as the **`E2E_PAT`** repository secret. `e2e-live-events.yml` runs the model via OpenRouter (`openrouter:deepseek/deepseek-v4-flash`), keyed off its own **`OPENROUTER_API_KEY`** secret rather than the `PROVIDER_API_KEY` secret `e2e.yml`/`demo.yml` use for OpenAI — the two never collide. Without either secret, every job below skips cleanly.
- **Branch reality.** `issue_comment`/`issues`/`pull_request_review_comment` workflows always run from the workflow file on the **default branch**, never from a PR's branch. This harness validates `main` _after_ merge — it's a post-merge confidence check, not a PR gate like `e2e.yml`.

How to run: **Actions → E2E Live Events Orchestrator → Run workflow**.

## Making changes

### Add a model provider

1. Add a `case` to the `switch` in [`src/agent/model.ts`](src/agent/model.ts) returning a LangChain chat model.
2. If the provider should be inferable from a bare model name, add a prefix rule to `PROVIDER_BY_PREFIX` in [`src/config.ts`](src/config.ts).
3. Add a price entry to [`src/agent/cost.ts`](src/agent/cost.ts) if you want cost estimates.
4. Document it in [`action.yml`](action.yml) (the `model` input description) and [`docs/providers.md`](docs/providers.md).
5. Add it to the smoke path so CI exercises the import.

### Change inputs

Inputs are declared in [`action.yml`](action.yml) and parsed in [`src/config.ts`](src/config.ts) (`loadConfig`). Keep the three in sync: `action.yml`, `loadConfig`, and the docs tables in `README.md` / `docs/configuration.md`. Execution policy is workflow-owned: [`src/config/repoConfig.ts`](src/config/repoConfig.ts) supports only `system_prompt`.

### Add a test

Tests use Bun's runner and live in `test/`, one file per module. Prefer pure, unit-testable functions (see how `normalizeModel`, `isPermitted`, `checkContainsTrigger`, and `estimateCostUsd` are tested).

## Pull requests

- Keep changes focused; match the existing code style (Prettier-enforced).
- Update docs and `action.yml` alongside behavior changes.
- Ensure `typecheck`, `test`, `format:check`, and `smoke` all pass.
- Describe what changed and how you tested it (the PR template prompts for this).

## Reporting bugs & requesting features

Use the [issue templates](.github/ISSUE_TEMPLATE/). For security issues, **do not** open a public issue — follow [SECURITY.md](SECURITY.md).

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).

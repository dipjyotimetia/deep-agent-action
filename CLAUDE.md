# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Runtime is **Bun** (pinned in `action.yml`). There is **no build/bundle step** — the action runs `src/index.ts` directly via `bun run`. Never create or commit a `dist/`.

CI (`.github/workflows/ci.yml`) runs typecheck → format:check → test → smoke on every push/PR. Run all four locally before pushing.

**The smoke check is not optional.** `bun run smoke` instantiates every provider model and exits without any network call. It exists to catch the one class of bug that source-run unit tests cannot: provider packages failing to load. Run it after touching dependencies or `src/agent/model.ts`.

## Architecture

### Control-plane pipeline (`src/index.ts`, `src/flows/`)

`run()` in `index.ts` gates the event, then hands off to `flows/implement.ts` or `flows/review.ts`; `flows/shared.ts` holds what they share (streaming, comment mirroring, landing). The agent is sandwiched between gating (before) and landing (after); both are done by this control plane, never by the model.

### Agent assembly (`src/agent/`)

`recursionLimit` defaults to 150 as a run-level ceiling; the harness's own default (10,000) would let a confused agent run far longer.

### Critical constraints (these are the easy things to break)

- **Static model imports are mandatory.** `agent/model.ts` constructs each LangChain chat model with a *static* import and hands the instance to `createDeepAgent`. Do **not** refactor this to pass a `"provider:model"` string — that path uses LangChain's dynamic `import()`, which fails to resolve at runtime. The smoke check guards this.
- **Pass `permissions` to `createDeepAgent` itself.** Declarative subagents inherit the top-level `permissions` argument, not rules given to a custom filesystem middleware. `PERMISSION_FLOOR` (`policy.ts`) keeps `.deepagents` read-only and `.git` out of reach, ahead of all custom rules.
- **Todos are opt-in upstream.** `todoListMiddleware()` must stay in implement mode: `write_todos`, comment progress, `@agent resume`, and the stall guard depend on it. Keep it out of review mode: two `afterModel` hooks break `toolStrategy`'s retry (a langchain bug, see the comment in `createAgent.ts`).
- **Harness artifacts must not reach the checkout.** Evicted tool results and summarized history are written straight through the backend, bypassing permissions. `artifactRoutes` sends them to a temp directory; without it `git add -A` publishes them.
- **Only the Docker sandbox isolates the shell and stdio MCP servers.** `agent/env.ts` is an *allow-list* that keeps secrets out of the shell's environment (don't add secret-bearing names), and `shellGuard.ts` is a guardrail, but on the runner, allow-listed interpreters can read the action's secrets through `/proc` on Linux. `shell_sandbox: auto` therefore refuses runs driven by outside input (`untrustedInputReason`) unless an image is set; don't weaken that check, and don't describe the local shell as secret-free or sandboxed.
- **The built-in command deny-list cannot be weakened.** `loadConfig` always merges `DEFAULT_DENIED_COMMANDS` (`config.ts`), and execution policy is workflow-owned: `.github/deep-agent.yml` supports only `system_prompt`. `shellGuard.ts` enforces allow/deny per quote-aware segment, refuses command substitution, `.git`, and `/proc` access, and reserves `git` commit/push/config-style subcommands for the control plane.
- **The agent never lands anything; assume it tampered with the checkout.** Commit/branch/push/PR operations live in `github/ops.ts`, using the scoped token via `execFileSync` (no shell). Never call git around `runGit`, which disables hooks and fsmonitor, ignores user-level config, and strips secrets from the environment. `landChangesForRun` must run in this order: terminate the shell (`ShellRunner.terminateAll`), `restoreGitTrust`, `flattenAgentCommits`, `assertPublishableChanges`, then land.
- **A fork head is untrusted input.** `isUntrustedPrHead` means: fetch through `refs/pull/N/head`, never its branch name; always land as a proposal; ignore its `.deepagents` guidance and repo `system_prompt`.
- **Deepagents repository guidance is intentionally narrow.** Only `.deepagents/AGENTS.md` and `.deepagents/skills/` are discovered, and issue/PR text stays in a separate user-message data section.
- **No interrupts, checkpointer, or store.** The runner is ephemeral and cannot resume a graph. `@agent resume` starts a fresh run seeded from sticky-comment memory. `thread_id` is only an identifier here.
- **ESM with explicit `.js` import extensions.** Source is `.ts` but imports use `.js` (e.g. `from "./config.js"`). Keep this when adding imports.

### Review mode

The review agent has a plain filesystem backend, so no shell exists, and only read/search tools. It returns findings as a validated structured response (`ReviewResponseSchema`, `toolStrategy`), which `reviewFromResult` turns into the review. A run with no structured response fails visibly; it never posts an empty review. Auto-applied suggestions must target contained, non-symlink regular files in GitHub's changed-file list. Editing review behavior usually means touching `agent/createAgent.ts`, the review system prompt (`agent/prompt.ts`), `github/review.ts`, and `flows/review.ts`.

## Making changes

- **Tests** are one `*.test.ts` per module under `test/`, Bun's runner, no network. Prefer extracting pure functions and testing those (see `normalizeModel`, `checkContainsTrigger`, `evaluateCommand`, `estimateCostUsd`).
- **`test/agentContract.test.ts` drives the real deepagents graph** with a scripted model. Add to it whenever you rely on harness behavior: mocked-stream tests cannot notice when an upstream release changes what the harness provides. Live Docker tests in `test/shellExec.test.ts` and `test/mcp.test.ts` run when `DEEP_AGENT_DOCKER_TEST_IMAGE` and `DEEP_AGENT_DOCKER_TEST_NODE_IMAGE` are set (CI sets them).

Deeper detail — full file map, the live E2E harness (`.github/workflows/e2e.yml`), and the threat model — is in `CONTRIBUTING.md` and `docs/` (`configuration.md`, `providers.md`, `security.md`, `troubleshooting.md`).

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

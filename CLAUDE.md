# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Runtime is **Bun** (pinned in `action.yml`). There is **no build/bundle step** — the action runs `src/index.ts` directly via `bun run`. Never create or commit a `dist/`.

CI (`.github/workflows/ci.yml`) runs typecheck → format:check → test → smoke on every push/PR. Run all four locally before pushing.

**The smoke check is not optional.** `bun run smoke` instantiates every provider model and exits without any network call. It exists to catch the one class of bug that source-run unit tests cannot: provider packages failing to load. Run it after touching dependencies or `src/agent/model.ts`.

## Architecture

### Control-plane pipeline (`src/index.ts`)

`run()` is a single linear orchestration. The agent is sandwiched between gating (before) and landing (after); both are done by this control plane, never by the model.

### Agent assembly (`src/agent/`)

`recursionLimit` is raised to 150 because a read→edit→test→fix loop exceeds LangGraph's default 25.

### Critical constraints (these are the easy things to break)

- **Static model imports are mandatory.** `agent/model.ts` constructs each LangChain chat model with a *static* import and hands the instance to `createDeepAgent`. Do **not** refactor this to pass a `"provider:model"` string — that path uses LangChain's dynamic `import()`, which fails to resolve at runtime. The smoke check guards this.
- **The agent shell is secret-free by construction.** `agent/env.ts` is an *allow-list* of env var names; provider keys, `GITHUB_TOKEN`, App keys, and `INPUT_*` are excluded, so they can never leak into a model-directed shell command. Don't add secret-bearing names to that list.
- **The built-in command deny-list cannot be weakened.** `mergeRepoConfig` always re-merges `DEFAULT_DENIED_COMMANDS` (`config.ts`), so a committed repo config can narrow the allow-list and add denials but never remove a default denial. `shellGuard.ts` enforces allow/deny per command segment plus a global token scan (for denials hidden in `$(...)`).
- **The agent never runs git/push.** It only edits files in the workspace; all commit/branch/push/PR operations live in `github/ops.ts` and run with the scoped token via `execFileSync("git", ...)` (no shell — injection-safe).
- **Deepagents repository guidance is intentionally narrow.** Only `.deepagents/AGENTS.md` and `.deepagents/skills/` are discovered. Built-in filesystem writes under `.deepagents/` are denied before custom permission rules; issue/PR text stays in a separate user-message data section.
- **Interrupts are safe stops, not durable resumes.** MCP tools are interrupted by default when configured. The action records pending requests, lands partial work through the approval path, and a later `@agent resume` starts a fresh run using sticky-comment memory because the runner has no persistent checkpointer/store.
- **ESM with explicit `.js` import extensions.** Source is `.ts` but imports use `.js` (e.g. `from "./config.js"`). Keep this when adding imports.

### Review-mode handoff

In review mode the agent has no repository edit, shell, or MCP tools. It writes findings to `/review-output/findings.json`, which is routed to temporary storage outside the checkout; the control plane reads and removes that handoff before posting the inline review. Auto-applied suggestions must target contained, non-symlink regular files in GitHub's changed-file list. Editing review behavior usually means touching `agent/createAgent.ts`, the review system prompt (`agent/prompt.ts`), and `github/review.ts`.

## Making changes

- **Tests** are one `*.test.ts` per module under `test/`, Bun's runner, no network. Prefer extracting pure functions and testing those (see `normalizeModel`, `checkContainsTrigger`, `evaluateCommand`, `estimateCostUsd`).

Deeper detail — full file map, the live E2E harness (`.github/workflows/e2e.yml`), and the threat model — is in `CONTRIBUTING.md` and `docs/` (`configuration.md`, `providers.md`, `security.md`, `troubleshooting.md`).

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

# Troubleshooting

Start by opening the workflow run in the **Actions** tab — the log says why a run was a no-op, refused, or failed, and the sticky comment on the issue/PR mirrors the outcome.

## The agent didn't respond at all

The run was likely a **no-op**. Check, in order:

1. **The workflow listens to the event you used.** A comment on an issue fires `issue_comment`; a comment on a PR's *Files changed* tab fires `pull_request_review_comment`. If your `on:` block doesn't include the event, nothing runs.
2. **The trigger phrase matches.** It must appear at a word boundary and is case-insensitive. `@agent do X` matches; `email@agentcorp.com` does not. If you changed `trigger_phrase`, use the new phrase.
3. **It's a supported action type.** For `issues`, only `opened, reopened, edited, assigned, labeled` are considered; for `pull_request`, only `opened, reopened, ready_for_review, edited`. Bare `pull_request` events without a mention are intentionally a no-op.
4. **`workflow_dispatch` runs** need a non-empty `prompt` input — there's no mention to parse.

## "Request not authorized" / `status: refused`

The trigger was seen but the actor wasn't allowed:

- **Insufficient permission.** The actor needs a level listed in `allowed_permissions` (default `write,admin`). A first-time or read-only contributor will be refused.
- **Fork PR.** PRs from forks are denied unless a maintainer applies the `fork_allow_label`. If you didn't set that input, fork PRs never run — by design.
- **Bot actor.** Bot accounts are ignored to prevent trigger loops.

The refusal comment names the specific reason.

## "GitHub Actions is not permitted to create or approve pull requests"

The action opens PRs with the `GITHUB_TOKEN`, which GitHub blocks by default. Fix it one of two ways:

- **Enable the setting** (simplest): repo **Settings → Actions → General → Workflow permissions → check "Allow GitHub Actions to create and approve pull requests"**. As a repo admin you can also do it via the API:

  ```bash
  gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow \
    -f default_workflow_permissions=read \
    -F can_approve_pull_request_reviews=true
  ```

- **Use a GitHub App** (`app_id` + `app_private_key`) — its token isn't subject to this setting, and its PRs also trigger your other CI. See [examples/github-app.yml](../examples/github-app.yml).

Note: the workflow must also grant `permissions: pull-requests: write` (and `contents: write`), as the [examples](../examples/) do.

## The agent opened a PR, but my CI didn't run on it

This is expected when using the default `GITHUB_TOKEN`: PRs it creates **do not** trigger other workflows (GitHub prevents recursive automation). Fix by giving the agent a **GitHub App** identity — see [examples/github-app.yml](../examples/github-app.yml) and [docs/configuration.md](configuration.md#identity--landing).

## Model / provider authentication errors

- **Missing key.** Ensure `PROVIDER_API_KEY` (or the provider-specific variable) is set under `env:` and the secret exists in repo settings.
- **Wrong provider inferred.** A bare model name infers the provider from its prefix. For anything other than `claude…`/`gpt…`/`gemini…`, use an explicit `provider:model` id.
- **`openai-compatible` fails fast.** It requires `base_url`. Set the endpoint (e.g. `https://api.groq.com/openai/v1`).
- **Bedrock / Vertex / Azure.** These use their own credential chains, not `PROVIDER_API_KEY`. See [docs/providers.md](providers.md).

## Cost shows token counts but no `$` amount

The model name isn't in the estimate table in [`src/agent/cost.ts`](../src/agent/cost.ts), so only tokens are reported. The run still succeeded — the cost figure is a best-effort estimate, not a billing source.

## A code review posted one summary comment instead of inline comments

Inline review comments can only attach to lines present in the PR diff. When a finding's line isn't in the diff (or the inline post fails), the action falls back to a single summary comment containing the findings. This is a graceful degradation, not an error.

## A shell command the agent wanted to run was blocked

That's the guardrail working. The command isn't on the allow-list, or it's on the always-on deny-list. To permit more, widen `allowed_commands` (workflow input or `.github/deep-agent.yml`). The deny-list (`curl`, `wget`, `sudo`, …) cannot be overridden. See [docs/security.md](security.md#4-command-guardrails).

## Changes didn't land on the PR branch

If `require_push_approval: true`, that's intended: in PR mode the agent pushes a **proposed branch** and posts a compare link rather than pushing to the PR branch; in issue mode it opens a **draft PR**. A human approves to land. See [examples/approval-gate.yml](../examples/approval-gate.yml).

## Checkout / missing-history errors

Use `actions/checkout` with `fetch-depth: 0` so the agent has full history to branch, diff, and push from.

## Duplicate or mangled tracking comments / a push failed with "non-fast-forward"

Two `@agent` mentions on the same thread can start two runs that race each other: both edit the same sticky tracking comment (last write wins, including its hidden memory block), and a push can be rejected as non-fast-forward when the branch moved mid-run. Serialize runs per thread with a workflow-level concurrency group:

```yaml
concurrency:
  group: deep-agent-${{ github.event.issue.number || github.event.pull_request.number || github.run_id }}
  cancel-in-progress: false # let the in-flight run finish and land its work
```

## A run aborted with a recursion-limit error

Very long multi-step tasks can reach the agent super-step ceiling (default `150`). Raise the `recursion_limit` input only when the run is making progress; repeated identical calls are stopped separately by `max_repeated_tool_calls` (default `8`). Consider `max_runtime_minutes` / the budget caps so a runaway task still stops gracefully.

## The run was stopped early ("max runtime" / "budget cap" banner)

That's `max_runtime_minutes` or `max_cost_usd` / `max_total_tokens` doing their job: the agent was aborted gracefully and any partial work landed through the approval path (draft PR / proposed branch) for review. The `timed_out` / `budget_stopped` outputs are set to `true`. Raise the cap if the task genuinely needs more.

## Still stuck?

Open an issue with the run URL, the `status` output, and the relevant log excerpt. The `deep-agent-run` artifact attached to the run contains the full machine-readable record.

## "Command blocked by policy"

The guard refused a shell command, and the reason is in the message and the audit record. Common cases since the guard became stricter:

- **`$(...)`, backticks, or `<(...)`:** command substitution isn't allowed; the agent should run the steps separately.
- **`git commit`, `push`, `config`, and similar:** these belong to the control plane. The agent should leave its changes uncommitted.
- **A path under `.git` or `/proc`:** refused. Use `git status`, `git diff`, or `git log` to inspect the repository.

## "Refusing to publish protected paths"

The run changed a protected file: `.deepagents/**`, a deep-agent config path, `.github/workflows/**`, or a `protected_paths` entry. Nothing was published. Make that change yourself in a normal PR.

## "Refusing to land: the agent replaced the .git directory"

The agent's commands replaced or redirected the Git directory, so the action won't run Git against it. Treat the run as suspicious and check what instruction it was given.

## "No review was posted"

The review agent stopped or finished without returning a structured result. The message says why. If it hit a limit, raise `max_cost_usd`, `max_total_tokens`, `max_runtime_minutes`, or `recursion_limit`, then ask again.

## "Refusing to run without a shell sandbox"

The run would execute fork PR code, or take its instructions from an issue someone other than the actor wrote, and no sandbox image is set. Set `shell_sandbox_image`, or `shell_sandbox: none` if you accept that commands could read this action's secrets.

## `shell_sandbox` failures

- **"the Docker daemon is unavailable":** the runner needs Docker. GitHub-hosted Linux runners have it; macOS and Windows runners do not.
- **"Could not pull shell_sandbox_image":** check the image reference and any registry login step earlier in the job.
- **A command isn't found inside the sandbox:** the tool must be in your image. Host toolchains aren't visible there.
- **Dependency installs fail:** the default network is `none`. Set `shell_sandbox_network: bridge`, or build dependencies into the image.
- **An MCP server fails to start:** its command (`npx`, `uvx`, …) must be in the image, or give that server its own `command: docker` configuration.

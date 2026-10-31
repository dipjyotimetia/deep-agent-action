# Examples

Copy any of these into `.github/workflows/` in your repository. Each is self-contained and uses `dipjyotimetia/deep-agent-action@main`.

The only secret you must add for the default model is `PROVIDER_API_KEY`; provider-specific setups may use `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, or cloud auth env vars such as AWS credentials, Azure OpenAI vars, or `GOOGLE_APPLICATION_CREDENTIALS`.

| File | What it shows |
|---|---|
| [`agent.yml`](agent.yml) | Production coding-agent starter: approval-gated landing, scoped shell commands, protected control-plane paths, and manual dispatch. |
| [`review.yml`](review.yml) | Production read-only code review on pull requests (`@agent review`) with bounded runtime and token use. |
| [`approval-gate.yml`](approval-gate.yml) | Require human approval before changes land (draft PR / proposed branch). |
| [`multi-provider.yml`](multi-provider.yml) | OpenAI, OpenRouter, OpenAI-compatible, Bedrock, and Vertex AI variants. |
| [`mcp-tools.yml`](mcp-tools.yml) | Approval-gated MCP setup with sandboxed servers, protected paths, and explicit cost/runtime limits. |
| [`github-app.yml`](github-app.yml) | GitHub App identity with approval-gated landing so generated PRs trigger your other CI workflows. |
| [`fork-support.yml`](fork-support.yml) | Allow fork PRs only after a maintainer applies a configured label, with commands sandboxed in Docker. |
| [`issue-automation.yml`](issue-automation.yml) | Automate issue-based requests into PRs using `@agent` on issues and issue comments. |

## Optional: per-repo config

Beyond the workflow, you can commit a `.github/deep-agent.yml` with a repository `system_prompt`. Keep all execution and security policy in the workflow. See [docs/configuration.md](../docs/configuration.md#per-repo-config-file).

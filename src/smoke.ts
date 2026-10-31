import * as core from "@actions/core";
import { createModel } from "./agent/model.js";
import { buildAgent } from "./agent/createAgent.js";

/**
 * Construct every provider model and both agent modes without any network call.
 * CI runs this from source (`DEEP_AGENT_SMOKE=1 bun run src/index.ts`), as the
 * composite action does, to catch provider packages that fail to load or
 * construct: the bug class that source-run unit tests cannot see.
 */
export async function smokeCheck(): Promise<void> {
  // Providers configured entirely through their standard environment.
  process.env.AZURE_OPENAI_API_INSTANCE_NAME ??= "smoke";
  process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME ??= "smoke";
  process.env.AZURE_OPENAI_API_VERSION ??= "2024-10-21";
  process.env.AWS_REGION ??= "us-east-1";

  const anthropic = createModel({
    provider: "anthropic",
    model: "claude-sonnet-5",
    apiKey: "smoke",
  });
  const models = [
    anthropic,
    createModel({ provider: "openai", model: "gpt-5", apiKey: "smoke" }),
    createModel({ provider: "azure", model: "gpt-5", apiKey: "smoke" }),
    createModel({ provider: "google", model: "gemini-2.5-pro", apiKey: "smoke" }),
    createModel({ provider: "openrouter", model: "openai/gpt-4o", apiKey: "smoke" }),
    createModel({
      provider: "openai-compatible",
      model: "llama",
      apiKey: "smoke",
      baseUrl: "http://localhost:1/v1",
    }),
    createModel({ provider: "bedrock", model: "anthropic.claude-3-5-sonnet-20241022-v2:0" }),
    createModel({ provider: "vertexai", model: "gemini-2.5-pro" }),
  ];
  const common = {
    model: anthropic,
    rootDir: process.cwd(),
    systemPrompt: "smoke",
    allowedCommands: ["echo"],
    deniedCommands: [],
    shellTimeoutSeconds: 5,
    toolCallRecord: [],
  };
  const implement = buildAgent({ ...common, mode: "implement" });
  const review = buildAgent({ ...common, mode: "review" });
  core.info(
    `smoke ok: ${models.map((m) => m.constructor.name).join(",")} ` +
      `implement=${typeof implement.stream} review=${typeof review.stream}`,
  );
}

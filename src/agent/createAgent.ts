import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompositeBackend,
  createDeepAgent,
  createFilesystemMiddleware,
  FilesystemBackend,
  registerHarnessProfile,
  type FilesystemPermission,
  type HarnessProfile,
} from "deepagents";
import { todoListMiddleware, toolStrategy } from "langchain";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { ReviewResponseSchema } from "../github/review.js";
import type { ToolCallRecord } from "../types.js";
import { GuardedLocalShellBackend } from "./shellGuard.js";
import type { ShellRunner } from "./shellExec.js";
import { buildShellEnv } from "./env.js";
import {
  buildFilesystemPermissions,
  buildReviewFilesystemPermissions,
  discoverDeepAgentSources,
} from "./policy.js";
import { resolveSubagents, type DeepAgentSubagentConfig } from "./subagents.js";

/** Largest shell output returned to the model from one command. */
export const SHELL_MAX_OUTPUT_BYTES = 200_000;

interface BuildAgentCommonOptions {
  model: BaseChatModel;
  rootDir: string;
  systemPrompt: string;
  allowedCommands: string[];
  deniedCommands: string[];
  shellTimeoutSeconds: number;
  /** Provider-prefixed model id used to register a custom harness profile. */
  modelSpec?: string;
  /** Optional validated deepagents harness profile. */
  harnessProfile?: HarnessProfile;
  /** Optional filesystem permission rules layered below the memory write-protection floor. */
  filesystemPermissions?: FilesystemPermission[];
  /** Optional synchronous specialist subagents; ignored in read-only review mode. */
  subagents?: DeepAgentSubagentConfig[];
  /** Builds a statically imported provider model for an opted-in specialist override. */
  subagentModelFor?: (model: string) => BaseChatModel;
  /** Mutable sink the shell guard appends tool-call records to. */
  toolCallRecord: ToolCallRecord[];
  /**
   * Whether `.deepagents` in the checkout may shape the agent. False for an
   * untrusted fork head, whose guidance would otherwise act as instructions.
   */
  trustRepoGuidance?: boolean;
  /** Directory outside the checkout for harness artifacts; created when omitted. */
  artifactDir?: string;
}

export type BuildAgentOptions = BuildAgentCommonOptions &
  (
    | {
        mode: "implement";
        /** Extra tools (e.g. from MCP servers) added alongside the built-in tools. */
        extraTools?: DynamicStructuredTool[];
        /** Executes approved shell commands; the caller terminates it before landing. */
        shellRunner?: ShellRunner;
      }
    | {
        mode: "review";
      }
  );

export interface ResolveAgentPolicyOptions {
  rootDir: string;
  filesystemPermissions?: FilesystemPermission[];
  trustRepoGuidance?: boolean;
}

/**
 * Turn the action's provider-prefixed model id into a deepagents-compatible
 * exact profile key. Bedrock ids can contain a second colon, while deepagents
 * profile keys accept only `provider:model`.
 */
function profileLookupKey(modelSpec: string): string | undefined {
  const separator = modelSpec.indexOf(":");
  if (separator <= 0 || separator === modelSpec.length - 1) return undefined;
  const provider = modelSpec.slice(0, separator);
  const model = modelSpec.slice(separator + 1).replaceAll(":", "_");
  return `${provider}:${model}`;
}

/** Resolve repository sources and deepagents policy before constructing the graph. */
export function resolveAgentPolicy(opts: ResolveAgentPolicyOptions): {
  memory?: string[];
  skills?: string[];
  permissions: FilesystemPermission[];
} {
  const sources = opts.trustRepoGuidance === false ? {} : discoverDeepAgentSources(opts.rootDir);
  return {
    memory: sources.memory,
    skills: sources.skills,
    permissions: buildFilesystemPermissions(opts.filesystemPermissions),
  };
}

function registerProfile(
  model: BaseChatModel,
  modelSpec: string | undefined,
  profile: HarnessProfile,
): void {
  const profileKeys = new Set<string>();
  // deepagents resolves profiles from the concrete LangChain model class.
  // OpenRouter and openai-compatible models are ChatOpenAI instances, so
  // register the OpenAI alias as well as the user-facing provider key.
  const modelName = model.getName();
  if (modelName === "ChatAnthropic") profileKeys.add("anthropic");
  if (modelName === "ChatOpenAI") profileKeys.add("openai");
  if (modelName === "ChatGoogleGenerativeAI") profileKeys.add("google");

  // Some supported LangChain adapters (notably Bedrock and Vertex) do not
  // expose a provider name that deepagents can infer. Register a sanitized
  // exact key and supply it through LangChain's optional `model_name`
  // metadata field. This leaves the provider's real `model` request field
  // untouched while making the profile apply instead of silently no-oping.
  if (modelSpec) {
    const exactKey = profileLookupKey(modelSpec);
    if (exactKey) {
      registerHarnessProfile(exactKey, profile);
      if (!profileKeys.size) {
        const modelWithMetadata = model as BaseChatModel & { model_name?: unknown };
        if (modelWithMetadata.model_name === undefined) {
          modelWithMetadata.model_name = exactKey;
        }
      }
    }
    const separator = modelSpec.indexOf(":");
    if (separator > 0) profileKeys.add(modelSpec.slice(0, separator));
  }
  for (const key of profileKeys) registerHarnessProfile(key, profile);
}

/**
 * Harness-owned virtual paths, routed outside the checkout. The harness writes
 * evicted tool results and summarized history directly through the backend,
 * bypassing permission rules, and anything left in the checkout gets committed.
 */
function artifactRoutes(artifactDir: string | undefined): Record<string, FilesystemBackend> {
  const root =
    artifactDir ?? mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "deep-agent-artifacts-"));
  const routes: Record<string, FilesystemBackend> = {};
  for (const name of ["large_tool_results", "conversation_history"]) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    routes[`/${name}/`] = new FilesystemBackend({ rootDir: dir, virtualMode: true });
  }
  return routes;
}

/**
 * Assemble the in-runner Deep Agent.
 *
 * Implement mode gets a guarded shell backend rooted at the workspace, which
 * enables the built-in `execute` tool. Review mode gets a plain filesystem
 * backend, so no shell exists to reach, and returns its findings as a structured
 * response instead of writing anything.
 */
export function buildAgent(opts: BuildAgentOptions) {
  if (opts.harnessProfile) registerProfile(opts.model, opts.modelSpec, opts.harnessProfile);

  const policy = resolveAgentPolicy({
    rootDir: opts.rootDir,
    filesystemPermissions: opts.filesystemPermissions,
    trustRepoGuidance: opts.trustRepoGuidance,
  });
  const routes = artifactRoutes(opts.artifactDir);

  if (opts.mode === "review") {
    // Sandbox the built-in filesystem tools to the workspace via `virtualMode`:
    // absolute paths resolve under rootDir and nothing reaches outside it.
    const backend = new CompositeBackend(
      new FilesystemBackend({ rootDir: opts.rootDir, virtualMode: true }),
      routes,
    );
    const permissions = buildReviewFilesystemPermissions(opts.filesystemPermissions);
    return createDeepAgent({
      model: opts.model,
      backend,
      systemPrompt: opts.systemPrompt,
      permissions,
      responseFormat: toolStrategy(ReviewResponseSchema),
      // No todo middleware here. With it, the stack has two `afterModel` hooks, and
      // langchain's `toolStrategy` retry after an invalid response then throws
      // InvalidUpdateError on `jumpTo` (langchain 1.6.0; related to langchainjs#10175).
      // A review needs no plan, and the contract tests cover this retry.
      middleware: [
        // Replaces the default filesystem middleware by name, for the general-
        // purpose subagent too, removing every mutating tool.
        createFilesystemMiddleware({
          backend,
          permissions,
          tools: ["ls", "read_file", "glob", "grep"],
        }),
      ],
      memory: policy.memory,
      skills: policy.skills,
    });
  }

  // Sandbox the built-in filesystem tools (ls/glob/grep/read/edit) to the
  // workspace via `virtualMode`. With the default (virtualMode=false) those
  // tools accept arbitrary absolute paths, so an exploratory model can glob
  // outside the repo — and deepagents' fast-glob calls are not wrapped in
  // try/catch, which means an unreadable directory (e.g. `/home/packer` on the
  // GitHub runner image) throws EACCES and crashes the whole run. In virtual
  // mode absolute paths are treated as virtual paths under rootDir and anything
  // resolving outside the root is returned empty/error to the model instead of
  // reaching the filesystem. The `execute` tool is NOT affected: it goes to the
  // `ShellRunner`, gated by the command allow/deny list.
  const shellBackend = new GuardedLocalShellBackend(
    {
      rootDir: opts.rootDir,
      virtualMode: true,
      env: buildShellEnv(),
      timeout: opts.shellTimeoutSeconds,
      maxOutputBytes: SHELL_MAX_OUTPUT_BYTES,
    },
    {
      allowed: opts.allowedCommands,
      denied: opts.deniedCommands,
      record: opts.toolCallRecord,
      runner: opts.shellRunner,
    },
  );

  const extraTools = opts.extraTools ?? [];
  const subagentConfigs =
    opts.trustRepoGuidance === false
      ? opts.subagents?.map(({ skills: _skills, ...config }) => config)
      : opts.subagents;
  const subagents = resolveSubagents(
    subagentConfigs,
    extraTools,
    policy.permissions,
    policy.skills,
    opts.subagentModelFor,
  );

  // deepagents rejects filesystem permissions on a raw shell backend because
  // shell commands can bypass path rules. A root composite route makes the
  // permission scope explicit while keeping execute delegated to the same
  // backend (and preserving virtualMode path containment).
  const backend = new CompositeBackend(shellBackend, { "/": shellBackend, ...routes });

  return createDeepAgent({
    model: opts.model,
    backend,
    systemPrompt: opts.systemPrompt,
    // Must stay top-level: declarative subagents fall back to this, not to any
    // filesystem middleware passed through `middleware`.
    permissions: policy.permissions,
    // The harness made todos opt-in; plans, progress mirroring, `@agent resume`,
    // and the stall guard's progress signal all depend on them.
    middleware: [todoListMiddleware()],
    tools: extraTools,
    ...(subagents.length ? { subagents } : {}),
    memory: policy.memory,
    skills: policy.skills,
  });
}

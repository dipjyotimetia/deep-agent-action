import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { FilesystemPermission, SubAgent } from "deepagents";
import { z } from "zod";
import { parseFilesystemPermissionsValue, PERMISSION_FLOOR } from "./policy.js";

const RESERVED_SUBAGENT_NAMES = new Set(["general-purpose"]);
const SUBAGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SKILL_ROOT = "/.deepagents/skills/";

const findingsResponseFormat = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      title: z.string(),
      detail: z.string(),
      file: z.string().optional(),
    }),
  ),
});

export interface DeepAgentSubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  /** Explicit MCP capability allow-list; specialists never inherit all tools. */
  mcpTools: string[];
  skills?: string[];
  /** Restrictive-only rules; custom subagents may never broaden parent access. */
  filesystemPermissions?: FilesystemPermission[];
  responseMode?: "findings";
}

const rawSubagentSchema = z
  .object({
    name: z.string().regex(SUBAGENT_NAME, "name must be a short identifier"),
    description: z.string().min(1),
    systemPrompt: z.string().min(1).optional(),
    system_prompt: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    mcpTools: z.array(z.string().min(1)).optional(),
    mcp_tools: z.array(z.string().min(1)).optional(),
    skills: z.array(z.string().min(1)).optional(),
    filesystemPermissions: z.unknown().optional(),
    filesystem_permissions: z.unknown().optional(),
    responseMode: z.enum(["findings"]).optional(),
    response_mode: z.enum(["findings"]).optional(),
  })
  .strict();

function oneOf<T>(value: { camel?: T; snake?: T }, field: string, name: string): T | undefined {
  if (value.camel !== undefined && value.snake !== undefined) {
    throw new Error(`${name} must not specify both ${field} and its snake_case alias.`);
  }
  return value.camel ?? value.snake;
}

function parseConfig(value: unknown, name: string): DeepAgentSubagentConfig[] {
  const parsed = rawSubagentSchema.array().safeParse(value);
  if (!parsed.success) throw new Error(`${name} is invalid: ${parsed.error.message}`);

  const names = new Set<string>();
  return parsed.data.map((raw) => {
    if (RESERVED_SUBAGENT_NAMES.has(raw.name)) {
      throw new Error(`${name} must not override the reserved general-purpose subagent.`);
    }
    if (names.has(raw.name))
      throw new Error(`${name} names must be unique; found "${raw.name}" twice.`);
    names.add(raw.name);

    const systemPrompt = oneOf(
      { camel: raw.systemPrompt, snake: raw.system_prompt },
      "systemPrompt",
      name,
    );
    if (!systemPrompt) throw new Error(`${name}.${raw.name} requires systemPrompt.`);
    const mcpTools = oneOf({ camel: raw.mcpTools, snake: raw.mcp_tools }, "mcpTools", name);
    if (!mcpTools?.length) {
      throw new Error(`${name}.${raw.name} requires a non-empty mcpTools allow-list.`);
    }
    if (new Set(mcpTools).size !== mcpTools.length) {
      throw new Error(`${name}.${raw.name}.mcpTools must not contain duplicates.`);
    }
    const filesystemValue = oneOf(
      { camel: raw.filesystemPermissions, snake: raw.filesystem_permissions },
      "filesystemPermissions",
      name,
    );
    const responseMode = oneOf(
      { camel: raw.responseMode, snake: raw.response_mode },
      "responseMode",
      name,
    );
    const filesystemPermissions =
      filesystemValue === undefined
        ? undefined
        : parseFilesystemPermissionsValue(
            filesystemValue,
            `${name}.${raw.name}.filesystemPermissions`,
          );
    if (filesystemPermissions?.some((rule) => rule.mode !== "deny")) {
      throw new Error(
        `${name}.${raw.name}.filesystemPermissions may contain only deny rules so it cannot broaden access.`,
      );
    }
    if (
      raw.skills?.some(
        (path) => !path.startsWith(SKILL_ROOT) || path.includes("..") || path.includes("~"),
      )
    ) {
      throw new Error(`${name}.${raw.name}.skills must stay beneath ${SKILL_ROOT}.`);
    }

    return {
      name: raw.name,
      description: raw.description,
      systemPrompt,
      model: raw.model,
      mcpTools,
      ...(raw.skills?.length ? { skills: raw.skills } : {}),
      ...(filesystemPermissions?.length ? { filesystemPermissions } : {}),
      ...(responseMode ? { responseMode } : {}),
    };
  });
}

/** Parse an optional JSON action input containing specialist subagent declarations. */
export function parseSubagents(
  raw: string | undefined,
  name = "subagents",
): DeepAgentSubagentConfig[] | undefined {
  if (!raw?.trim()) return undefined;
  try {
    return parseConfig(JSON.parse(raw), name);
  } catch (err) {
    throw new Error(`${name} is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Parse an already-decoded YAML specialist subagent declaration list. */
export function parseSubagentsValue(
  value: unknown,
  name = "subagents",
): DeepAgentSubagentConfig[] | undefined {
  if (value === undefined) return undefined;
  return parseConfig(value, name);
}

/**
 * Insert restrictive custom rules ahead of the parent's workflow rules, leaving
 * the immutable floor first. Without restrictions the subagent inherits the
 * top-level `permissions` passed to `createDeepAgent`.
 */
function subagentPermissions(
  parent: FilesystemPermission[],
  restrictions?: FilesystemPermission[],
): FilesystemPermission[] | undefined {
  if (!restrictions?.length) return undefined;
  const floor = PERMISSION_FLOOR.length;
  return [...parent.slice(0, floor), ...restrictions, ...parent.slice(floor)];
}

/**
 * Resolve declarative configuration into the real tools/models Deep Agents accepts.
 * Every referenced MCP tool must exist; there is no fallback to broader tool access.
 */
export function resolveSubagents(
  configs: DeepAgentSubagentConfig[] | undefined,
  availableMcpTools: DynamicStructuredTool[],
  parentPermissions: FilesystemPermission[],
  inheritedSkills: string[] | undefined,
  modelFor?: (model: string) => BaseChatModel,
): SubAgent[] {
  if (!configs?.length) return [];
  const byName = new Map(availableMcpTools.map((tool) => [tool.name, tool]));
  return configs.map((config) => {
    const names = config.mcpTools;
    const tools = names.map((name) => {
      const tool = byName.get(name);
      if (!tool)
        throw new Error(`subagents.${config.name} references unavailable MCP tool "${name}".`);
      return tool;
    });
    if (config.model && !modelFor) {
      throw new Error(`subagents.${config.name} configured a model without a model factory.`);
    }
    const permissions = subagentPermissions(parentPermissions, config.filesystemPermissions);
    return {
      name: config.name,
      description: config.description,
      systemPrompt: config.systemPrompt,
      ...(tools.length ? { tools } : {}),
      ...(config.model ? { model: modelFor!(config.model) } : {}),
      ...(config.skills
        ? { skills: config.skills }
        : inheritedSkills
          ? { skills: inheritedSkills }
          : {}),
      ...(permissions ? { permissions } : {}),
      ...(config.responseMode === "findings" ? { responseFormat: findingsResponseFormat } : {}),
    };
  });
}

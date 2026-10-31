import * as core from "@actions/core";
import { z } from "zod";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Light structural check: the config must be a plain object — either the
 * documented `{ mcpServers: { ... } }` form or a flat `{ name: connection }`
 * map, both of which `MultiServerMCPClient` accepts. We deliberately don't model
 * the full server-config union here (it would drift from the library); the
 * constructor still validates the details.
 */
const McpConfigSchema = z.looseObject({});

export interface McpHandle {
  tools: DynamicStructuredTool[];
  close: () => Promise<void>;
}

const EMPTY: McpHandle = { tools: [], close: async () => {} };

/**
 * Load tools from MCP servers described by an `mcp_config` JSON string
 * (`{ "mcpServers": { name: { command, args, env } | { url } } }`).
 *
 * Best-effort: invalid JSON or a server that fails to connect logs a warning
 * and yields no tools, so a broken MCP config never aborts the run. The config
 * is workflow-author-controlled (not from untrusted issue text).
 */
export async function loadMcpTools(configJson: string): Promise<McpHandle> {
  if (!configJson.trim()) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch (err) {
    core.warning(
      `Ignoring mcp_config: invalid JSON (${err instanceof Error ? err.message : err}).`,
    );
    return EMPTY;
  }

  if (!McpConfigSchema.safeParse(parsed).success) {
    core.warning('Ignoring mcp_config: expected a JSON object (e.g. { "mcpServers": { ... } }).');
    return EMPTY;
  }

  let client: MultiServerMCPClient | undefined;
  try {
    client = new MultiServerMCPClient(
      parsed as ConstructorParameters<typeof MultiServerMCPClient>[0],
    );
    const tools = await client.getTools();
    core.info(`Loaded ${tools.length} MCP tool(s).`);
    const connected = client;
    return { tools, close: () => connected.close() };
  } catch (err) {
    core.warning(`Failed to load MCP tools: ${err instanceof Error ? err.message : err}.`);
    // A server may have started before another failed; don't leave it running.
    await client?.close().catch(() => {});
    return EMPTY;
  }
}

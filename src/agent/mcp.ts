import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@actions/core";
import { z } from "zod";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { buildDockerMcpArgs, dockerClientEnv, killContainer } from "./shellExec.js";

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

/** Where stdio MCP servers run when the workflow sandboxes its shell. */
export interface McpSandboxOptions {
  image: string;
  network: "none" | "bridge";
  workspace: string;
}

type Connection = Record<string, unknown> & { command?: unknown; args?: unknown; env?: unknown };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const isStdio = (server: Connection) =>
  typeof server.command === "string" && (server.transport ?? server.type ?? "stdio") === "stdio";

/**
 * Rewrite each stdio server to run in its own container, so a compromised or
 * misused server can't reach the action's secrets. Pure. HTTP servers already run
 * elsewhere, and a server configured as `docker` chose its own container, so
 * neither is changed.
 */
export function sandboxMcpConfig(
  config: Record<string, unknown>,
  sandbox: McpSandboxOptions & { home: string; prefix: string; uid?: number; gid?: number },
  clientEnv: Record<string, string> = {},
): { config: Record<string, unknown>; containers: string[]; selfContained: string[] } {
  const containers: string[] = [];
  const selfContained: string[] = [];
  const nested = "mcpServers" in config;
  const servers = nested ? asRecord(config.mcpServers) : config;

  const rewritten = Object.fromEntries(
    Object.entries(servers).map(([serverName, value]) => {
      const server = asRecord(value) as Connection;
      if (!isStdio(server)) return [serverName, value];
      if (server.command === "docker") {
        selfContained.push(serverName);
        return [serverName, value];
      }
      const name = `${sandbox.prefix}-${serverName.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
      containers.push(name);
      const env = asRecord(server.env) as Record<string, string>;
      const { cwd: _cwd, ...rest } = server;
      return [
        serverName,
        {
          ...rest,
          command: "docker",
          args: buildDockerMcpArgs({
            name,
            image: sandbox.image,
            network: sandbox.network,
            workspace: sandbox.workspace,
            home: sandbox.home,
            uid: sandbox.uid,
            gid: sandbox.gid,
            envNames: Object.keys(env),
            command: server.command as string,
            args: Array.isArray(server.args) ? server.args.map(String) : [],
          }),
          env: { ...clientEnv, ...env },
        },
      ];
    }),
  );
  return {
    config: nested ? { ...config, mcpServers: rewritten } : rewritten,
    containers,
    selfContained,
  };
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
export async function loadMcpTools(
  configJson: string,
  sandbox?: McpSandboxOptions,
): Promise<McpHandle> {
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

  let config = parsed as Record<string, unknown>;
  let containers: string[] = [];
  let home: string | undefined;
  if (sandbox) {
    home = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "deep-agent-mcp-home-"));
    const result = sandboxMcpConfig(
      config,
      {
        ...sandbox,
        home,
        prefix: `deep-agent-mcp-${randomUUID().slice(0, 8)}`,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
      },
      dockerClientEnv(),
    );
    config = result.config;
    containers = result.containers;
    for (const name of result.selfContained) {
      core.warning(
        `MCP server "${name}" sets its own docker command, so its flags decide its isolation.`,
      );
    }
  }

  let client: MultiServerMCPClient | undefined;
  const close = async () => {
    await client?.close().catch(() => {});
    await Promise.all(containers.map(killContainer));
    if (home) rmSync(home, { recursive: true, force: true });
  };
  try {
    client = new MultiServerMCPClient(
      config as ConstructorParameters<typeof MultiServerMCPClient>[0],
    );
    const tools = await client.getTools();
    core.info(`Loaded ${tools.length} MCP tool(s).`);
    return { tools, close };
  } catch (err) {
    core.warning(`Failed to load MCP tools: ${err instanceof Error ? err.message : err}.`);
    // A server may have started before another failed; don't leave it running.
    await close();
    return EMPTY;
  }
}

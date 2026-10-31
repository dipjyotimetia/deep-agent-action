import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadMcpTools, sandboxMcpConfig } from "../src/agent/mcp.js";

const sandbox = {
  image: "node:22",
  network: "bridge" as const,
  workspace: "/repo",
  home: "/scratch",
  prefix: "mcp-test",
  uid: 1001,
  gid: 121,
};

describe("sandboxMcpConfig", () => {
  const config = {
    throwOnLoadError: false,
    mcpServers: {
      fetch: {
        command: "uvx",
        args: ["mcp-server-fetch"],
        env: { API_KEY: "server-secret" },
        cwd: "/host/path",
      },
      remote: { url: "https://mcp.example.com" },
      own: { command: "docker", args: ["run", "-i", "their/image"] },
    },
  };
  const result = sandboxMcpConfig(config, sandbox, { PATH: "/usr/bin" });
  const servers = result.config.mcpServers as Record<string, any>;

  test("runs a stdio server in a hardened container", () => {
    const { command, args } = servers.fetch;
    const joined = args.join(" ");
    expect(command).toBe("docker");
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--network bridge");
    expect(joined).toContain("--user 1001:121");
    expect(joined).toContain("type=bind,src=/repo,dst=/workspace,readonly");
    expect(args.slice(-3)).toEqual(["node:22", "uvx", "mcp-server-fetch"]);
    expect(servers.fetch.cwd).toBeUndefined();
  });

  test("keeps a server's secrets out of its command line", () => {
    const { args, env } = servers.fetch;
    expect(args.join(" ")).not.toContain("server-secret");
    expect(args[args.indexOf("API_KEY") - 1]).toBe("--env");
    expect(env.API_KEY).toBe("server-secret");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("leaves HTTP servers and self-containerized servers alone, naming the latter", () => {
    expect(servers.remote).toEqual(config.mcpServers.remote);
    expect(servers.own).toEqual(config.mcpServers.own);
    expect(result.selfContained).toEqual(["own"]);
    expect(result.containers).toEqual(["mcp-test-fetch"]);
  });

  test("keeps client options and handles the flat config form", () => {
    expect(result.config.throwOnLoadError).toBe(false);
    const flat = sandboxMcpConfig({ a: { command: "x" } }, sandbox);
    expect((flat.config.a as any).command).toBe("docker");
    expect(flat.config.mcpServers).toBeUndefined();
  });

  test("makes a safe container name from any server name", () => {
    const named = sandboxMcpConfig({ "my server/1": { command: "x" } }, sandbox);
    expect(named.containers).toEqual(["mcp-test-my-server-1"]);
  });
});

describe("loadMcpTools", () => {
  test("no config, invalid config, and failing servers yield no tools, not an error", async () => {
    expect((await loadMcpTools("")).tools).toEqual([]);
    expect((await loadMcpTools("{not json")).tools).toEqual([]);
    expect((await loadMcpTools("[1]")).tools).toEqual([]);
  });
});

// A real MCP server over stdio, written inline so the test needs only a Node image.
const SERVER = `
const out = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const probe = () => {
  let wrote = false;
  try { fs.writeFileSync("/workspace/mcp-wrote.txt", "x"); wrote = true; } catch {}
  return {
    ownSecret: process.env.MCP_OWN_SECRET,
    hostSecret: process.env.DA_HOST_SECRET ?? null,
    pid1Env: read("/proc/1/environ").includes("DA_HOST_SECRET"),
    wroteWorkspace: wrote,
    readWorkspace: read("/workspace/visible.txt"),
    home: process.env.HOME,
  };
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (m.method === "initialize") out(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
    else if (m.method === "tools/list") out(m.id, { tools: [{ name: "probe", description: "probe", inputSchema: { type: "object", properties: {} } }] });
    else if (m.method === "tools/call") out(m.id, { content: [{ type: "text", text: JSON.stringify(probe()) }] });
  }
});
`;

const nodeImage = process.env.DEEP_AGENT_DOCKER_TEST_NODE_IMAGE;

describe.skipIf(!nodeImage)("sandboxed stdio MCP server (live)", () => {
  test("works over the protocol but can't reach the action's secrets or change the workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "da-mcp-"));
    execFileSync("sh", ["-c", "echo seen > visible.txt"], { cwd: workspace });
    process.env.DA_HOST_SECRET = "host-secret-value";
    const mcp = await loadMcpTools(
      JSON.stringify({
        mcpServers: {
          probe: { command: "node", args: ["-e", SERVER], env: { MCP_OWN_SECRET: "own-value" } },
        },
      }),
      { image: nodeImage!, network: "none", workspace },
    );
    delete process.env.DA_HOST_SECRET;

    try {
      expect(mcp.tools.map((t) => t.name)).toContain("probe");
      const result = await mcp.tools[0]!.invoke({});
      const text = typeof result === "string" ? result : JSON.stringify(result);
      const seen = JSON.parse(
        text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1).replace(/\\"/g, '"'),
      );
      expect(seen.ownSecret).toBe("own-value");
      expect(seen.hostSecret).toBeNull();
      expect(seen.pid1Env).toBe(false);
      expect(seen.wroteWorkspace).toBe(false);
      expect(seen.readWorkspace).toBe("seen\n");
      expect(seen.home).toBe("/sandbox-home");
    } finally {
      await mcp.close();
    }

    await Bun.sleep(500);
    const left = execFileSync("docker", ["ps", "-aq", "--filter", "name=deep-agent-mcp-"], {
      encoding: "utf8",
    });
    expect(left.trim()).toBe("");
  }, 60_000);
});

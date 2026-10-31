import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecuteResponse } from "deepagents";

const execFileAsync = promisify(execFile);

/** How long a terminated process gets to exit before it is force-killed. */
const TERMINATE_GRACE_MS = 1_000;
/** How long to keep reading after a command exits, before giving up on its pipes. */
const PIPE_DRAIN_MS = 250;
/** Longest a `docker kill` may take before falling back to killing the client. */
const DOCKER_KILL_TIMEOUT_MS = 10_000;
/** Exit code reported when a command runs after the shell was shut down. */
const SHELL_CLOSED_EXIT_CODE = 125;

/**
 * Executes model-directed shell commands. The caller owns the lifecycle:
 * `terminateAll` must run before landing, so nothing the agent started can keep
 * writing to the workspace or the Git directory while the control plane commits.
 */
export interface ShellRunner {
  /** Validate prerequisites before any model call; throws when they are unmet. */
  prepare(): Promise<void>;
  run(command: string): Promise<ExecuteResponse>;
  /** Stop everything still running and refuse new commands. Safe to call repeatedly. */
  terminateAll(): Promise<void>;
}

export interface ShellRunnerOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

/** Collects combined output with a hard memory cap, matching deepagents' response format. */
class OutputBuffer {
  private stdout = "";
  private stderr = "";
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    const room = this.maxBytes - (this.stdout.length + this.stderr.length);
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    const text = chunk.toString();
    if (text.length > room) this.truncated = true;
    this[stream] += text.slice(0, room);
  }

  toResponse(exitCode: number): ExecuteResponse {
    const parts: string[] = [];
    if (this.stdout) parts.push(this.stdout);
    if (this.stderr) {
      parts.push(
        ...this.stderr
          .trim()
          .split("\n")
          .map((line) => `[stderr] ${line}`),
      );
    }
    let output = parts.length > 0 ? parts.join("\n") : "<no output>";
    if (this.truncated) output += `\n\n... Output truncated at ${this.maxBytes} bytes.`;
    if (exitCode !== 0) output = `${output.trimEnd()}\n\nExit code: ${exitCode}`;
    return { output, exitCode, truncated: this.truncated };
  }
}

/**
 * Release a child's pipes so waiting on it cannot hang. A process that left the
 * killed group (e.g. via `setsid`) can hold them open indefinitely.
 */
function releasePipes(child: ChildProcess): void {
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** Run a child process to completion, with output capture and a timeout. */
function captureChild(
  child: ChildProcess,
  opts: { timeoutSeconds: number; maxOutputBytes: number; onTimeout: () => void },
): Promise<ExecuteResponse> {
  return new Promise((resolve) => {
    const buffer = new OutputBuffer(opts.maxOutputBytes);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      opts.onTimeout();
      setTimeout(() => releasePipes(child), TERMINATE_GRACE_MS).unref();
    }, opts.timeoutSeconds * 1000);
    child.stdout?.on("data", (data: Buffer) => buffer.append("stdout", data));
    child.stderr?.on("data", (data: Buffer) => buffer.append("stderr", data));
    // `close` waits for the pipes, which a backgrounded child can hold open for as
    // long as it runs. The command is finished when its own process exits.
    child.on("exit", () => {
      setTimeout(() => releasePipes(child), PIPE_DRAIN_MS).unref();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        output: `Error executing command: ${err.message}`,
        exitCode: 1,
        truncated: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          output: `Error: Command timed out after ${opts.timeoutSeconds.toFixed(1)} seconds.`,
          exitCode: 124,
          truncated: false,
        });
        return;
      }
      resolve(buffer.toResponse(code ?? 1));
    });
  });
}

function closedResponse(): ExecuteResponse {
  return {
    output: "Command not executed: the agent run has already stopped.",
    exitCode: SHELL_CLOSED_EXIT_CODE,
    truncated: false,
  };
}

/**
 * Runs each command in its own process group on the runner, so a timeout or a
 * run-level abort reaches background children too. This is process control, not
 * isolation: a command can still leave its group with `setsid`. Use
 * `DockerShellRunner` for a real boundary.
 */
export class LocalShellRunner implements ShellRunner {
  private readonly groups = new Set<number>();
  private readonly running = new Map<ChildProcess, Promise<unknown>>();
  private closed = false;

  constructor(private readonly opts: ShellRunnerOptions) {}

  async prepare(): Promise<void> {}

  run(command: string): Promise<ExecuteResponse> {
    if (this.closed) return Promise.resolve(closedResponse());
    // Windows has no POSIX process groups, so it keeps plain child-process control.
    const isWindows = process.platform === "win32";
    const spawnOptions = {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
    const child = isWindows
      ? spawn(command, { ...spawnOptions, shell: true })
      : spawn("/bin/sh", ["-c", command], { ...spawnOptions, detached: true });
    const pgid = isWindows ? undefined : child.pid;
    if (pgid != null) this.groups.add(pgid);
    const result = captureChild(child, {
      timeoutSeconds: this.opts.timeoutSeconds,
      maxOutputBytes: this.opts.maxOutputBytes,
      onTimeout: () => {
        if (pgid != null) signalGroup(pgid, "SIGKILL");
        else child.kill("SIGKILL");
      },
    }).finally(() => {
      // Background children outlive the leader, so keep the group tracked until
      // it is empty: `terminateAll` must still be able to reach them.
      if (pgid != null && !groupAlive(pgid)) this.groups.delete(pgid);
      this.running.delete(child);
    });
    this.running.set(child, result);
    return result;
  }

  async terminateAll(): Promise<void> {
    this.closed = true;
    const groups = [...this.groups];
    for (const pgid of groups) signalGroup(pgid, "SIGTERM");
    if (groups.some(groupAlive)) await delay(TERMINATE_GRACE_MS);
    for (const pgid of groups) signalGroup(pgid, "SIGKILL");
    this.groups.clear();
    for (const child of this.running.keys()) {
      child.kill("SIGKILL");
      releasePipes(child);
    }
    await Promise.allSettled([...this.running.values()]);
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group already exited.
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DockerSandboxOptions {
  image: string;
  network: "none" | "bridge";
}

/** Non-secret names forwarded into the sandbox; host toolchain paths do not apply there. */
const SANDBOX_ENV_PASSTHROUGH = [
  "LANG",
  "LC_ALL",
  "TZ",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "RUNNER_OS",
  "RUNNER_ARCH",
];

/** Environment for the Docker client itself; never reaches the container. */
const DOCKER_CLIENT_ENV = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];

/** Hardening shared by every container this action starts. */
const DOCKER_HARDENING_ARGS = [
  "--init",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "4096",
];

/** The environment for running the Docker client itself. */
export function dockerClientEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DOCKER_CLIENT_ENV) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

/**
 * Check Docker and the image before any model call, pulling the image if needed,
 * so a missing prerequisite fails clearly instead of as a slow first command.
 */
export async function prepareDockerImage(image: string): Promise<void> {
  const docker = (args: string[]) => execFileAsync("docker", args, { env: dockerClientEnv() });
  try {
    await docker(["version", "--format", "{{.Server.Version}}"]);
  } catch (err) {
    throw new Error(
      `shell_sandbox is "docker" but the Docker daemon is unavailable: ${errorMessage(err)}`,
    );
  }
  try {
    await docker(["image", "inspect", image]);
  } catch {
    try {
      await docker(["pull", image]);
    } catch (err) {
      throw new Error(`Could not pull shell_sandbox_image "${image}": ${errorMessage(err)}`);
    }
  }
}

/** Stop a named container, ignoring one that has already gone. */
export async function killContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["kill", name], {
    env: dockerClientEnv(),
    timeout: DOCKER_KILL_TIMEOUT_MS,
  }).catch(() => {});
}

export const SANDBOX_WORKSPACE = "/workspace";
export const SANDBOX_HOME = "/sandbox-home";

/** Build the curated environment visible inside the sandbox container. */
export function buildSandboxEnv(source: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SANDBOX_ENV_PASSTHROUGH) {
    const value = source[name];
    if (value) env[name] = value;
  }
  env.CI = "true";
  env.HOME = SANDBOX_HOME;
  env.GITHUB_WORKSPACE = SANDBOX_WORKSPACE;
  env.GIT_TERMINAL_PROMPT = "0";
  // `.git` is mounted read-only; don't let `git status` try to refresh the index.
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/**
 * Pure `docker run` argument builder. Each command gets a fresh container with
 * no capabilities, no host process visibility, and a read-only `.git`, so
 * nothing it does can reach the control plane's secrets or Git configuration.
 */
export function buildDockerRunArgs(params: {
  name: string;
  image: string;
  network: "none" | "bridge";
  workspace: string;
  home: string;
  uid?: number;
  gid?: number;
  env: Record<string, string>;
  command: string;
  mountGitReadOnly: boolean;
}): string[] {
  const args = [
    "run",
    "--rm",
    "--name",
    params.name,
    "--network",
    params.network,
    ...DOCKER_HARDENING_ARGS,
    "--workdir",
    SANDBOX_WORKSPACE,
    "--mount",
    `type=bind,src=${params.workspace},dst=${SANDBOX_WORKSPACE}`,
    "--mount",
    `type=bind,src=${params.home},dst=${SANDBOX_HOME}`,
  ];
  if (params.mountGitReadOnly) {
    args.push(
      "--mount",
      `type=bind,src=${join(params.workspace, ".git")},dst=${SANDBOX_WORKSPACE}/.git,readonly`,
    );
  }
  // Match the runner's user so created files stay owned by the workspace owner.
  if (params.uid != null && params.gid != null) args.push("--user", `${params.uid}:${params.gid}`);
  for (const [key, value] of Object.entries(params.env)) args.push("--env", `${key}=${value}`);
  args.push(params.image, "/bin/sh", "-c", params.command);
  return args;
}

/**
 * Pure `docker run` argument builder for a stdio MCP server. Same hardening as a
 * shell command, with stdin kept open for the protocol. The workspace is read-only:
 * only the agent's own tools may change what lands. A server's environment is
 * named here and its values travel through the client's environment, keeping
 * credentials out of the process list.
 */
export function buildDockerMcpArgs(params: {
  name: string;
  image: string;
  network: "none" | "bridge";
  workspace: string;
  home: string;
  uid?: number;
  gid?: number;
  envNames: string[];
  command: string;
  args: string[];
}): string[] {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    params.name,
    "--network",
    params.network,
    ...DOCKER_HARDENING_ARGS,
    "--workdir",
    SANDBOX_WORKSPACE,
    "--mount",
    `type=bind,src=${params.workspace},dst=${SANDBOX_WORKSPACE},readonly`,
    "--mount",
    `type=bind,src=${params.home},dst=${SANDBOX_HOME}`,
    "--env",
    `HOME=${SANDBOX_HOME}`,
    "--env",
    "CI=true",
  ];
  if (params.uid != null && params.gid != null) args.push("--user", `${params.uid}:${params.gid}`);
  for (const name of params.envNames) args.push("--env", name);
  args.push(params.image, params.command, ...params.args);
  return args;
}

/**
 * Runs each command in a throwaway Docker container. Only the workspace and a
 * scratch home are mounted; the Docker socket, runner temp directory, and action
 * secrets are not. Filesystem tools stay on the host, under the deepagents
 * permission rules, so only `execute` crosses this boundary.
 */
export class DockerShellRunner implements ShellRunner {
  private readonly active = new Map<string, { child: ChildProcess; result: Promise<unknown> }>();
  private readonly clientEnv: Record<string, string>;
  private readonly home: string;
  private readonly prefix = `deep-agent-sh-${randomUUID().slice(0, 8)}`;
  private counter = 0;
  private closed = false;

  constructor(
    private readonly opts: ShellRunnerOptions,
    private readonly sandbox: DockerSandboxOptions,
  ) {
    this.clientEnv = dockerClientEnv();
    this.home = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "deep-agent-sandbox-home-"));
  }

  async prepare(): Promise<void> {
    await prepareDockerImage(this.sandbox.image);
  }

  run(command: string): Promise<ExecuteResponse> {
    if (this.closed) return Promise.resolve(closedResponse());
    const name = `${this.prefix}-${++this.counter}`;
    const child = spawn(
      "docker",
      buildDockerRunArgs({
        name,
        image: this.sandbox.image,
        network: this.sandbox.network,
        workspace: this.opts.cwd,
        home: this.home,
        uid: process.getuid?.(),
        gid: process.getgid?.(),
        env: buildSandboxEnv(this.opts.env),
        command,
        mountGitReadOnly: isDirectory(join(this.opts.cwd, ".git")),
      }),
      { env: this.clientEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    const result = captureChild(child, {
      timeoutSeconds: this.opts.timeoutSeconds,
      maxOutputBytes: this.opts.maxOutputBytes,
      onTimeout: () => void this.kill(name, child),
    }).finally(() => this.active.delete(name));
    this.active.set(name, { child, result });
    return result;
  }

  async terminateAll(): Promise<void> {
    this.closed = true;
    const running = [...this.active.entries()];
    await Promise.allSettled(running.map(([name, { child }]) => this.kill(name, child)));
    for (const [, { child }] of running) releasePipes(child);
    await Promise.allSettled(running.map(([, { result }]) => result));
    try {
      rmSync(this.home, { recursive: true, force: true });
    } catch {
      // Scratch space on a disposable runner; never let cleanup replace the outcome.
    }
  }

  /** Stop a container, then its client: the client waits on a container that's gone. */
  private async kill(name: string, child: ChildProcess): Promise<void> {
    await killContainer(name);
    child.kill("SIGKILL");
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildDockerRunArgs,
  buildSandboxEnv,
  DockerShellRunner,
  LocalShellRunner,
} from "../src/agent/shellExec.js";

const dir = () => mkdtempSync(join(tmpdir(), "da-shell-exec-"));
const options = (cwd: string, overrides = {}) => ({
  cwd,
  env: { PATH: process.env.PATH ?? "" },
  timeoutSeconds: 10,
  maxOutputBytes: 10_000,
  ...overrides,
});

describe("LocalShellRunner", () => {
  test("returns output and exit codes in deepagents' format", async () => {
    const runner = new LocalShellRunner(options(dir()));
    expect(await runner.run("echo hi")).toEqual({
      output: "hi\n",
      exitCode: 0,
      truncated: false,
    });
    const failed = await runner.run("echo oops >&2; exit 3");
    expect(failed.exitCode).toBe(3);
    expect(failed.output).toContain("[stderr] oops");
    expect(failed.output).toContain("Exit code: 3");
  });

  test("runs with only the environment it was given", async () => {
    const runner = new LocalShellRunner(options(dir(), { env: { PATH: "/usr/bin:/bin" } }));
    process.env.DA_TEST_SECRET = "leak";
    const result = await runner.run('echo "[$DA_TEST_SECRET]"');
    delete process.env.DA_TEST_SECRET;
    expect(result.output).toContain("[]");
  });

  test("a command that backgrounds a child finishes when it does, keeping its output", async () => {
    const runner = new LocalShellRunner(options(dir(), { timeoutSeconds: 8 }));
    const startedAt = Date.now();
    const result = await runner.run("sleep 30 & echo hi");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hi");
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    await runner.terminateAll();
  }, 15_000);

  test("caps captured output", async () => {
    const runner = new LocalShellRunner(options(dir(), { maxOutputBytes: 100 }));
    const result = await runner.run("yes x | head -c 100000");
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("Output truncated at 100 bytes");
  });

  test("a timeout kills background children, not only the shell", async () => {
    const cwd = dir();
    const runner = new LocalShellRunner(options(cwd, { timeoutSeconds: 0.3 }));
    const result = await runner.run("(sleep 0.8; touch late.txt) & wait");
    expect(result.exitCode).toBe(124);
    await Bun.sleep(1_000);
    expect(existsSync(join(cwd, "late.txt"))).toBe(false);
  });

  test("terminateAll stops running commands and refuses new ones", async () => {
    const cwd = dir();
    const runner = new LocalShellRunner(options(cwd));
    const running = runner.run("sleep 0.6; touch late.txt");
    await Bun.sleep(100);
    await runner.terminateAll();
    await running;
    await Bun.sleep(800);
    expect(existsSync(join(cwd, "late.txt"))).toBe(false);

    const refused = await runner.run("touch after.txt");
    expect(refused.exitCode).toBe(125);
    expect(existsSync(join(cwd, "after.txt"))).toBe(false);
  });

  test("terminateAll reaches a background child whose leader already exited", async () => {
    const cwd = dir();
    const runner = new LocalShellRunner(options(cwd));
    await runner.run("(sleep 0.6; touch late.txt) >/dev/null 2>&1 &");
    await runner.terminateAll();
    await Bun.sleep(800);
    expect(existsSync(join(cwd, "late.txt"))).toBe(false);
  });

  test("terminateAll cannot hang on a process holding the output pipes open", async () => {
    const cwd = dir();
    writeFileSync(
      join(cwd, "escape.js"),
      `require("child_process").spawn("sleep", ["5"], { detached: true, stdio: "inherit" }).unref();`,
    );
    const runner = new LocalShellRunner(options(cwd));
    const running = runner.run("node escape.js");
    await Bun.sleep(300);
    const startedAt = Date.now();
    await runner.terminateAll();
    await running;
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});

describe("buildDockerRunArgs", () => {
  const args = buildDockerRunArgs({
    name: "c1",
    image: "alpine:3",
    network: "none",
    workspace: "/repo",
    home: "/scratch",
    uid: 1001,
    gid: 121,
    env: { CI: "true" },
    command: "echo hi",
    mountGitReadOnly: true,
  });
  const joined = args.join(" ");

  test("drops privileges and network by default", () => {
    expect(joined).toContain("--network none");
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(joined).toContain("--user 1001:121");
    expect(args).toContain("--rm");
  });

  test("mounts .git read-only over the workspace and exposes nothing else", () => {
    expect(joined).toContain("type=bind,src=/repo,dst=/workspace");
    expect(joined).toContain("type=bind,src=/repo/.git,dst=/workspace/.git,readonly");
    expect(args.filter((a) => a === "--mount")).toHaveLength(3);
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain("--privileged");
    expect(args).not.toContain("--pid");
  });

  test("passes the command as one argument, after the image", () => {
    expect(args.slice(-4)).toEqual(["alpine:3", "/bin/sh", "-c", "echo hi"]);
  });
});

describe("buildSandboxEnv", () => {
  test("forwards only safe names and rewrites host paths", () => {
    const env = buildSandboxEnv({
      PATH: "/host/bin",
      HOME: "/home/runner",
      GITHUB_SHA: "abc",
      GITHUB_WORKSPACE: "/host/repo",
      GITHUB_TOKEN: "secret",
      RUNNER_TEMP: "/host/temp",
    });
    expect(env.GITHUB_SHA).toBe("abc");
    expect(env.HOME).toBe("/sandbox-home");
    expect(env.GITHUB_WORKSPACE).toBe("/workspace");
    expect(env.PATH).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RUNNER_TEMP).toBeUndefined();
  });
});

// Needs a real Docker daemon, so it only runs where explicitly enabled (see CI).
const dockerImage = process.env.DEEP_AGENT_DOCKER_TEST_IMAGE;

describe.skipIf(!dockerImage)("DockerShellRunner (live)", () => {
  function repoWithRunner(network: "none" | "bridge" = "none") {
    const cwd = dir();
    execFileSync("git", ["init", "-q"], { cwd });
    const runner = new DockerShellRunner(options(cwd, { timeoutSeconds: 3 }), {
      image: dockerImage!,
      network,
    });
    return { cwd, runner };
  }

  test("prepare fails loudly for an unavailable image", async () => {
    const runner = new DockerShellRunner(options(dir()), {
      image: "deep-agent-action.invalid/no-such-image:missing",
      network: "none",
    });
    await expect(runner.prepare()).rejects.toThrow("shell_sandbox_image");
    await runner.terminateAll();
  }, 60_000);

  test("edits the workspace with the runner's ownership", async () => {
    const { cwd, runner } = repoWithRunner();
    await runner.prepare();
    expect((await runner.run("echo hi > made.txt && pwd")).output).toContain("/workspace");
    expect(execFileSync("cat", [join(cwd, "made.txt")], { encoding: "utf8" })).toBe("hi\n");
    expect(() => execFileSync("touch", [join(cwd, "made.txt")])).not.toThrow();
    await runner.terminateAll();
  }, 60_000);

  test("cannot see the control plane's secrets or processes", async () => {
    const { runner } = repoWithRunner();
    process.env.DA_DOCKER_SECRET = "leak";
    const env = await runner.run("env");
    const parents = await runner.run("cat /proc/1/environ | tr '\\0' '\\n'");
    delete process.env.DA_DOCKER_SECRET;
    expect(env.output).not.toContain("leak");
    expect(parents.output).not.toContain("leak");
    expect(env.output).toContain("HOME=/sandbox-home");
    await runner.terminateAll();
  }, 60_000);

  test("has no network and cannot write .git", async () => {
    const { cwd, runner } = repoWithRunner();
    const net = await runner.run("wget -q -T 2 -O - http://1.1.1.1 2>&1; echo status=$?");
    expect(net.output).not.toContain("status=0");
    const git = await runner.run("echo pwn >> .git/config");
    expect(git.exitCode).not.toBe(0);
    expect(execFileSync("cat", [join(cwd, ".git/config")], { encoding: "utf8" })).not.toContain(
      "pwn",
    );
    await runner.terminateAll();
  }, 60_000);

  test("a timeout kills the container", async () => {
    const { cwd, runner } = repoWithRunner();
    const result = await runner.run("sleep 8; touch late.txt");
    expect(result.exitCode).toBe(124);
    await Bun.sleep(1_000);
    expect(existsSync(join(cwd, "late.txt"))).toBe(false);
    await runner.terminateAll();
  }, 60_000);

  test("a command that backgrounds a process doesn't hang on it", async () => {
    const { runner } = repoWithRunner();
    const result = await runner.run("sleep 30 & echo hi");
    expect(result.output).toContain("hi");
    await runner.terminateAll();
  }, 60_000);

  test("terminateAll kills running containers and refuses new commands", async () => {
    const { cwd, runner } = repoWithRunner();
    const running = runner.run("sleep 2; touch late.txt");
    await Bun.sleep(800);
    await runner.terminateAll();
    await running;
    await Bun.sleep(1_800);
    expect(existsSync(join(cwd, "late.txt"))).toBe(false);
    expect((await runner.run("echo no")).exitCode).toBe(125);
  }, 60_000);
});

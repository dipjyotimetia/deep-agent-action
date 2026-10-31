/**
 * Environment variable names the agent's shell is allowed to see. This is an
 * ALLOW-list, so secrets (provider keys, GitHub App key, GITHUB_TOKEN, INPUT_*)
 * are never placed in the shell's environment. That alone doesn't isolate them:
 * on the host, a command can still read the parent process's environment through
 * `/proc`. Only `shell_sandbox: docker` puts them out of reach. Shell commands
 * start with an empty env, so this list is also what makes `git`/`node`/etc.
 * resolvable at all.
 */
export const SHELL_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TERM",
  "PWD",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  // Toolchain locations (non-secret).
  "NODE_PATH",
  "NVM_DIR",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  // Non-secret GitHub runner context.
  "GITHUB_WORKSPACE",
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "RUNNER_OS",
  "RUNNER_ARCH",
  "RUNNER_TEMP",
];

/** Build the curated environment for the agent's shell. */
export function buildShellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SHELL_ENV_ALLOWLIST) {
    const v = source[name];
    if (typeof v === "string" && v.length > 0) env[name] = v;
  }
  // Ensure a usable PATH even if the parent process lacks one.
  if (!env.PATH) env.PATH = "/usr/local/bin:/usr/bin:/bin";
  env.CI = "true";
  // Never let git block on an interactive credential/passphrase prompt.
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

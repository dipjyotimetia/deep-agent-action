import { posix } from "node:path";
import { LocalShellBackend, type ExecuteResponse, type LocalShellBackendOptions } from "deepagents";
import type { ToolCallRecord } from "../types.js";
import { LocalShellRunner, type ShellRunner } from "./shellExec.js";

/** Strip a leading directory path, leaving the executable basename. */
function basename(token: string): string {
  const cleaned = token.replace(/^['"]|['"]$/g, "");
  const slash = cleaned.lastIndexOf("/");
  return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

interface ParsedCommand {
  /** Operator-separated simple commands, as words with shell quoting removed. */
  segments: string[][];
  /** Files named by redirections; they aren't command words, but are paths it touches. */
  redirectTargets: string[];
  /** Words containing an unquoted glob, which the shell expands to other paths. */
  globWords: string[];
  /** True when the command runs a nested command (`$(...)`, backticks, `<(...)`). */
  hasSubstitution: boolean;
  /** True when it uses subshells or function definitions, which hide what runs. */
  hasGrouping: boolean;
  /** True when a quote is left open, so this parse may not match what `sh` would run. */
  unbalanced: boolean;
}

/**
 * Split a shell command into words and operator-separated segments the way `sh`
 * would, honoring quotes, escapes, comments, and redirections. Operators inside
 * quotes are literal text, and quoting cannot disguise a word (`cu""rl` is
 * `curl`). Anything this can't model precisely must be refused by the caller:
 * a difference from `sh` is a way past the allow-list.
 */
function parseCommand(command: string): ParsedCommand {
  const segments: string[][] = [];
  const redirectTargets: string[] = [];
  const globWords: string[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let wordHasGlob = false;
  let expectRedirectTarget = false;
  let hasSubstitution = false;
  let hasGrouping = false;
  let quote: "'" | '"' | undefined;

  const endWord = () => {
    if (inWord) {
      if (wordHasGlob) globWords.push(word);
      if (expectRedirectTarget) {
        redirectTargets.push(word);
        expectRedirectTarget = false;
      } else {
        words.push(word);
      }
    }
    word = "";
    inWord = false;
    wordHasGlob = false;
  };
  const endSegment = () => {
    endWord();
    expectRedirectTarget = false;
    if (words.length) segments.push(words);
    words = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
      continue;
    }

    if (ch === "\\") {
      if (next === "\n") {
        i++; // A line continuation joins lines; it doesn't start or end a word.
        continue;
      }
      inWord = true;
      if (next !== undefined) word += next;
      i++;
      continue;
    }

    if ((ch === "$" && next === "(") || ch === "`") hasSubstitution = true;

    if (quote === '"') {
      if (ch === '"') quote = undefined;
      else word += ch;
      continue;
    }

    if (ch === "#" && !inWord) {
      // A comment ends at the next newline, and a backslash can't extend it.
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === ";" || ch === "\n") {
      endSegment();
    } else if (ch === "|") {
      if (next === "|") i++;
      endSegment();
    } else if (ch === "&") {
      if (next === "&") {
        i++;
        endSegment();
      } else if (next === ">") {
        endWord(); // `&>` redirects output; it does not start a new command.
      } else if (command[i - 1] === ">" || command[i - 1] === "<") {
        endWord(); // `2>&1` duplicates a descriptor.
      } else {
        endSegment(); // A lone `&` backgrounds the left side and starts a new command.
      }
    } else if (ch === "<" || ch === ">") {
      if (next === "(") hasSubstitution = true;
      // A number directly before the operator is a descriptor, not an argument.
      if (/^\d+$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      expectRedirectTarget = true;
    } else if (ch === "(" || ch === ")") {
      endWord();
      hasGrouping = true;
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
    } else {
      if (ch === "*" || ch === "?" || ch === "[") wordHasGlob = true;
      word += ch;
      inWord = true;
    }
  }
  endSegment();
  return {
    segments,
    redirectTargets,
    globWords,
    hasSubstitution,
    hasGrouping,
    unbalanced: quote !== undefined,
  };
}

/** Index of the executable word, skipping leading VAR=value assignments. */
function commandIndex(words: string[]): number {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return i;
}

/** Variables that change which program or code an allow-listed command really runs. */
const DENIED_ASSIGNMENT = /^(PATH|IFS|ENV|BASH_ENV|SHELLOPTS|LD_\w*|DYLD_\w*|GIT_\w*)=/;

/** Whether a path names something under `.git`, in any spelling of its segments. */
function namesGitInternals(word: string): boolean {
  return /(^|[/=:])\.git($|\/)/.test(word);
}

/** Whether a path resolves into `/proc`, however it is spelled. */
function namesProc(word: string): boolean {
  const value = word.slice(Math.max(word.lastIndexOf("="), word.lastIndexOf(":")) + 1);
  return /^(\.\.\/)*\/?proc($|\/)/.test(
    value.startsWith("/") || value.startsWith("..") ? posix.normalize(value) : "",
  );
}

/** Whether an unquoted glob could expand to `.git` or a `/proc` path. */
function globReachesDeniedPath(word: string): boolean {
  const segments = word.split("/");
  const toRegex = (glob: string) =>
    new RegExp(
      `^${glob
        .replace(/[.+^$(){}|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
  const matches = (segment: string, name: string) => {
    // Like the shell, a wildcard can't match a leading dot.
    if (name.startsWith(".") && !segment.startsWith(".")) return false;
    try {
      return toRegex(segment).test(name);
    } catch {
      return true; // An unparseable bracket expression: assume the worst.
    }
  };
  if (segments.some((segment) => /[*?[]/.test(segment) && matches(segment, ".git"))) return true;
  const absolute = word.startsWith("/") || word.startsWith("..") ? posix.normalize(word) : "";
  const first = absolute.split("/").find((segment) => segment && segment !== "..");
  return first !== undefined && /[*?[]/.test(first) && matches(first, "proc");
}

function deniedPathReason(word: string, isGlob: boolean): string | undefined {
  if (namesGitInternals(word)) return "Git internals (.git)";
  if (namesProc(word)) return "/proc";
  return isGlob && globReachesDeniedPath(word) ? ".git or /proc" : undefined;
}

/** Global `git` options that can redirect it to other config, code, or repositories. */
const DENIED_GIT_OPTIONS = /^(-c|--config-env|--exec-path|--git-dir|--work-tree|--namespace)(=|$)/;

/**
 * `git` subcommands reserved for the control plane: anything that talks to a
 * remote, rewrites history, or changes configuration. Repository inspection and
 * working-tree commands stay available.
 */
const DENIED_GIT_SUBCOMMANDS = new Set([
  "am",
  "cherry-pick",
  "clone",
  "commit",
  "config",
  "credential",
  "daemon",
  "fetch",
  "filter-branch",
  "hook",
  "merge",
  "pull",
  "push",
  "rebase",
  "remote",
  "revert",
  "submodule",
  "symbolic-ref",
  "update-ref",
]);

function evaluateGit(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (DENIED_GIT_OPTIONS.test(arg)) {
      return `\`git ${arg.split("=")[0]}\` is reserved for the control plane.`;
    }
    if (arg === "-C") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg.includes("$")) return "`git` subcommands must be literal.";
    if (DENIED_GIT_SUBCOMMANDS.has(arg)) {
      return `\`git ${arg}\` is reserved for the control plane; leave your changes uncommitted in the working tree.`;
    }
    return undefined;
  }
  return undefined;
}

/** `find -exec` runs another program, which must pass the same allow/deny policy. */
function evaluateFind(
  args: string[],
  allowSet: Set<string>,
  denySet: Set<string>,
): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(args[i]!)) continue;
    const target = basename(args[i + 1] ?? "");
    if (denySet.has(target) || !allowSet.has(target)) {
      return `\`find ${args[i]}\` may only run allow-listed commands; \`${target}\` is not allowed.`;
    }
  }
  return undefined;
}

export interface CommandVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a shell command may run.
 *
 * Each operator-separated segment's executable must be in the allow-list and not
 * in the deny-list. Nested command execution, Git internals, and control-plane
 * `git` operations are rejected outright, and a global token scan rejects any
 * denied command appearing anywhere (e.g. inside an interpreter's arguments).
 *
 * This is a guardrail that bounds the blast radius of an injected instruction,
 * not a sandbox: allow-listed interpreters can still run arbitrary code. Real
 * isolation requires `shell_sandbox: docker`.
 */
export function evaluateCommand(
  command: string,
  allowed: string[],
  denied: string[],
): CommandVerdict {
  const cmd = (command ?? "").trim();
  if (!cmd) return { allowed: false, reason: "Empty command." };

  const allowSet = new Set(allowed);
  const denySet = new Set(denied);
  const parsed = parseCommand(cmd);

  if (parsed.unbalanced) return { allowed: false, reason: "Command has unbalanced quotes." };
  if (parsed.hasGrouping) {
    return {
      allowed: false,
      reason: "Subshells and function definitions are not allowed; run steps separately.",
    };
  }

  // Per-segment executable check.
  for (const words of parsed.segments) {
    const index = commandIndex(words);
    for (const assignment of words.slice(0, index)) {
      if (DENIED_ASSIGNMENT.test(assignment)) {
        return {
          allowed: false,
          reason: `Setting \`${assignment.split("=")[0]}\` is not allowed in shell commands.`,
        };
      }
    }
    const exe = words[index];
    if (exe === undefined) continue;
    const base = basename(exe);
    if (denySet.has(base)) {
      return { allowed: false, reason: `Command \`${base}\` is on the deny-list.` };
    }
    if (!allowSet.has(base)) {
      return {
        allowed: false,
        reason: `Command \`${base}\` is not on the allow-list. Allowed: ${allowed.join(", ")}.`,
      };
    }
    const args = words.slice(index + 1);
    const refusal =
      base === "git"
        ? evaluateGit(args)
        : base === "find"
          ? evaluateFind(args, allowSet, denySet)
          : undefined;
    if (refusal) return { allowed: false, reason: refusal };
  }

  // Global token scan for denied commands hidden in substitutions/args. Line
  // continuations are removed first, since the shell joins across them.
  for (const token of cmd
    .replace(/\\\n/g, "")
    .split(/[\s'"()`$]+/)
    .filter(Boolean)) {
    if (denySet.has(basename(token))) {
      return { allowed: false, reason: `Command \`${basename(token)}\` is on the deny-list.` };
    }
  }

  const globWords = new Set(parsed.globWords);
  for (const word of [...parsed.segments.flat(), ...parsed.redirectTargets]) {
    const label = deniedPathReason(word, globWords.has(word));
    if (label) return { allowed: false, reason: `Shell commands may not access ${label}.` };
  }

  if (parsed.hasSubstitution) {
    return {
      allowed: false,
      reason:
        "Command substitution ($(...), backticks, <(...)) is not allowed; run steps separately.",
    };
  }

  return { allowed: true };
}

export interface ShellGuardOptions {
  allowed: string[];
  denied: string[];
  record: ToolCallRecord[];
  /** Executes approved commands; defaults to a process-group runner on the host. */
  runner?: ShellRunner;
}

/**
 * Filesystem backend whose `execute` enforces and audits command policy at the
 * boundary shared by the main agent and every delegated subagent, then hands
 * approved commands to a `ShellRunner` the control plane can terminate.
 */
export class GuardedLocalShellBackend extends LocalShellBackend {
  private readonly runner: ShellRunner;

  constructor(
    backendOptions: LocalShellBackendOptions,
    private readonly guardOptions: ShellGuardOptions,
  ) {
    super(backendOptions);
    this.runner =
      guardOptions.runner ??
      new LocalShellRunner({
        cwd: backendOptions.rootDir ?? process.cwd(),
        env: backendOptions.env ?? {},
        timeoutSeconds: backendOptions.timeout ?? 120,
        maxOutputBytes: backendOptions.maxOutputBytes ?? 100_000,
      });
  }

  override async execute(command: string): Promise<ExecuteResponse> {
    const verdict = evaluateCommand(command, this.guardOptions.allowed, this.guardOptions.denied);
    this.guardOptions.record.push({
      name: "execute",
      args: { command },
      blocked: !verdict.allowed,
      reason: verdict.reason,
    });

    if (!verdict.allowed) {
      return {
        output: `Command blocked by policy: ${verdict.reason} The command was not executed.`,
        exitCode: 126,
        truncated: false,
      };
    }

    return this.runner.run(command);
  }
}

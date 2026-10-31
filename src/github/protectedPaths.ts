/** Paths the agent may read but can never publish. */
export const DEFAULT_PROTECTED_PATHS = [
  ".deepagents/**",
  ".github/deep-agent.yml",
  ".github/deep-agent.yaml",
  ".deep-agent.yml",
  ".deep-agent.yaml",
  ".github/workflows/**",
] as const;

/** Parse workflow-owner extensions to the immutable protected-path floor. */
export function parseProtectedPaths(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const paths = [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  for (const path of paths) {
    if (path.startsWith("/") || path.includes("..") || path.includes("~") || path.includes("\\")) {
      throw new Error(
        `protected_paths must contain normalized repository-relative glob patterns; got "${path}".`,
      );
    }
  }
  return paths;
}

/** Return changed paths that match any protected glob. */
export function findProtectedPaths(files: string[], protectedPaths: readonly string[]): string[] {
  return files.filter((file) => protectedPaths.some((pattern) => globMatches(file, pattern)));
}

/** Fail before either Git landing path can publish protected files. */
export function assertPublishableChanges(files: string[], protectedPaths: readonly string[]): void {
  const blocked = findProtectedPaths(files, protectedPaths);
  if (blocked.length) {
    throw new Error(`Refusing to publish protected paths: ${blocked.join(", ")}.`);
  }
}

function globMatches(path: string, pattern: string): boolean {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        expression += ".*";
        i++;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(path);
}

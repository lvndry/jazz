import { spawn } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

/**
 * Default ignore patterns when .gitignore is missing or empty (matches common VCS/build artifacts).
 */
const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

// ---------------------------------------------------------------------------
// External CLI tool detection with global caching
// ---------------------------------------------------------------------------

/**
 * Cache for external tool availability checks.
 * Each entry stores whether the tool was found (`true`), not found (`false`),
 * or hasn't been checked yet (`undefined`).
 */
const externalToolCache = new Map<string, boolean>();

/**
 * Check whether an external CLI tool is available on the system PATH.
 * The result is cached globally so subsequent calls return instantly.
 *
 * @param name - The binary name to probe (e.g. "rg", "fd", "fzf").
 * @param versionFlag - The flag to pass to verify the binary works (default "--version").
 * @returns `true` if the tool responded with exit code 0, `false` otherwise.
 */
export function checkExternalTool(name: string, versionFlag = "--version"): Promise<boolean> {
  const cached = externalToolCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const child = spawn(name, [versionFlag], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    child.on("close", (code) => {
      const available = code === 0;
      externalToolCache.set(name, available);
      resolve(available);
    });
    child.on("error", () => {
      externalToolCache.set(name, false);
      resolve(false);
    });
  });
}

/**
 * Helper to spawn an external process and collect stdout/stderr.
 * Returns a structured result with stdout, stderr, and exitCode.
 * Handles errors gracefully (returns exitCode 1 on spawn failure).
 */
export function spawnCollect(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, never, never> {
  return Effect.promise<{ stdout: string; stderr: string; exitCode: number }>(
    () =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, {
          cwd: options.cwd,
          stdio: ["ignore", "pipe", "pipe"],
          env: options.env,
          timeout: options.timeout ?? 30_000,
          detached: false,
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString();
        });
        child.stderr?.on("data", (data: Buffer) => {
          stderr += data.toString();
        });

        child.on("close", (code: number | null) => {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 });
        });
        child.on("error", (error: Error) => {
          resolve({ stdout: "", stderr: error.message, exitCode: 1 });
        });
      }),
  );
}

/**
 * Parse .gitignore content into fast-glob-compatible ignore patterns.
 * Skips empty lines, comments (#), and negation (!) lines.
 * See https://git-scm.com/docs/gitignore for pattern semantics.
 */
export function parseGitignoreToGlob(content: string): string[] {
  const patterns: string[] = [];
  const lines = content.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("!")) continue; // negation not supported in fast-glob ignore array

    const fromRoot = line.startsWith("/");
    const dirOnly = line.endsWith("/");
    const pattern = line.replace(/^\/+/, "").replace(/\/+$/, "");

    if (pattern === "" || pattern === "**") continue;

    if (fromRoot) {
      patterns.push(pattern);
      patterns.push(`${pattern}/**`);
    } else if (dirOnly) {
      patterns.push(`**/${pattern}/**`);
    } else {
      patterns.push(`**/${pattern}`);
      patterns.push(`**/${pattern}/**`);
    }
  }

  return patterns;
}

/**
 * Read .gitignore from the given directory and return fast-glob ignore patterns.
 * Falls back to DEFAULT_IGNORE_PATTERNS when the file is missing or empty.
 */
export function readGitignorePatterns(
  fs: FileSystem.FileSystem,
  dir: string,
): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const path = `${dir.replace(/\/+$/, "")}/.gitignore`;
    const content = yield* fs.readFileString(path).pipe(
      Effect.map(String),
      Effect.catchAll(() => Effect.succeed("")),
    );
    const parsed = parseGitignoreToGlob(content);
    // Always include default ignore patterns (node_modules, .git) alongside
    // user-defined gitignore patterns so they are never accidentally traversed.
    return [...new Set([...DEFAULT_IGNORE_PATTERNS, ...parsed])];
  });
}

/**
 * Normalize filter pattern to support both substring and regex matching
 */
export function normalizeFilterPattern(pattern?: string): {
  type: "substring" | "regex";
  value?: string;
  regex?: RegExp;
} {
  if (!pattern || pattern.trim() === "") return { type: "substring" };
  const trimmed = pattern.trim();
  if (trimmed.startsWith("re:")) {
    const body = trimmed.slice(3);
    try {
      return { type: "regex", regex: new RegExp(body) };
    } catch {
      return { type: "substring", value: body };
    }
  }

  return { type: "substring", value: trimmed };
}

/**
 * Normalize stat size to handle bigint, number, or string
 */
export function normalizeStatSize(size: unknown): number | string | null {
  if (typeof size === "bigint") {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    if (size <= maxSafe && size >= -maxSafe) {
      return Number(size);
    }

    return size.toString();
  }

  if (typeof size === "number") {
    return size;
  }

  if (typeof size === "string") {
    return size;
  }

  return null;
}

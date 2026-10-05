import { spawn } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { toError } from "@/core/utils/errors";
import { terminateProcessGroup } from "@/core/utils/process";
import {
  bindCappedStdio,
  decodeCappedText,
  DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
  type CollectedProcessOutput,
} from "../capped-output";

/**
 * Default ignore patterns when .gitignore is missing or empty (matches common VCS/build artifacts).
 */
const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

// ---------------------------------------------------------------------------
// External CLI tool detection with global caching
// ---------------------------------------------------------------------------

/**
 * Cap for a single tool probe. A `--version` call that needs more than this to
 * answer is not a usable fast-path tool.
 */
const EXTERNAL_TOOL_PROBE_TIMEOUT_MS = 5_000;

/**
 * Cache for external tool availability checks.
 * Each entry stores whether the tool was found (`true`), not found (`false`),
 * or hasn't been checked yet (`undefined`).
 */
const externalToolCache = new Map<string, boolean>();

/**
 * Check whether an external CLI tool is available on the system PATH.
 * The result is cached globally so subsequent calls return instantly.
 * The probe is capped at {@link EXTERNAL_TOOL_PROBE_TIMEOUT_MS}; a hang
 * resolves `false` instead of stalling the caller.
 *
 * @param name - The binary name to probe (e.g. "rg", "fd", "fzf").
 * @param versionFlag - The flag to pass to verify the binary works (default "--version").
 * @returns `true` if the tool responded with exit code 0, `false` otherwise.
 */
export function checkExternalTool(name: string, versionFlag = "--version"): Promise<boolean> {
  const cached = externalToolCache.get(name);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      externalToolCache.set(name, available);
      clearTimeout(timer);
      resolve(available);
    };

    const child = spawn(name, [versionFlag], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: EXTERNAL_TOOL_PROBE_TIMEOUT_MS,
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The child may already be gone; the timeout still settles the probe.
      }
      finish(false);
    }, EXTERNAL_TOOL_PROBE_TIMEOUT_MS);

    child.on("close", (code) => finish(code === 0));
    child.on("error", () => finish(false));
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
    /** Written to the child's stdin, which is then closed. */
    input?: string;
  } = {},
): Effect.Effect<CollectedProcessOutput, never, never> {
  return Effect.async<CollectedProcessOutput>((resume) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: options.env,
      timeout: options.timeout ?? 30_000,
      detached: false,
    });

    const snapshot = bindCappedStdio(child.stdout, child.stderr, DEFAULT_SPAWN_OUTPUT_CAP_BYTES);
    if (options.input !== undefined && child.stdin !== null) {
      // A child that exits without reading all of its input closes the pipe early.
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }

    child.on("close", (code: number | null) => {
      const collected = snapshot();
      const stdout = decodeCappedText(collected.stdout, {
        trim: "all",
        dropIncompleteLastLine: true,
      });
      const stderr = decodeCappedText(collected.stderr, {
        trim: "all",
        dropIncompleteLastLine: true,
      });
      resume(
        Effect.succeed({
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: code ?? 1,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        }),
      );
    });
    child.on("error", (error: Error) => {
      resume(
        Effect.succeed({
          stdout: "",
          stderr: error.message,
          exitCode: 1,
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      );
    });

    return Effect.promise(() => terminateProcessGroup(child));
  });
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
 * Maximum allowed length for user-provided regex patterns.
 * Longer patterns are rejected and treated as literal substrings.
 */
const MAX_REGEX_PATTERN_LENGTH = 1000;

/**
 * Detect regex patterns that are likely to cause catastrophic backtracking.
 * Rejects patterns with nested quantifiers like (a+)+, (a*)+, (a|b+)*, etc.
 * These patterns have exponential time complexity on non-matching inputs.
 *
 * @returns true if the pattern is potentially dangerous
 */
export function isUnsafeRegex(pattern: string): boolean {
  // Reject patterns that are too long
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return true;

  // Track nesting depth of groups and whether we're inside a quantified group
  let groupDepth = 0;
  let hasQuantifierInGroup = false;
  let inCharClass = false;
  let escaped = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    // Character classes [...] are safe from backtracking concerns
    if (ch === "[" && !inCharClass) {
      inCharClass = true;
      continue;
    }
    if (ch === "]" && inCharClass) {
      inCharClass = false;
      continue;
    }
    if (inCharClass) continue;

    if (ch === "(") {
      groupDepth++;
      hasQuantifierInGroup = false;
      continue;
    }

    if (ch === ")") {
      const isQuantifiedGroup = hasQuantifierInGroup;
      groupDepth--;
      // Check if the group itself is followed by a quantifier
      const next = pattern[i + 1];
      if (next === "+" || next === "*" || next === "{") {
        // A quantified group that contains a quantifier → catastrophic backtracking
        if (isQuantifiedGroup) return true;
      }
      continue;
    }

    // Detect quantifiers inside groups — any quantifier inside a group that
    // is itself quantified creates exponential backtracking potential
    if (groupDepth > 0 && (ch === "+" || ch === "*" || ch === "{")) {
      hasQuantifierInGroup = true;
    }
  }

  return false;
}

export interface FilterPatternResult {
  type: "substring" | "regex";
  value?: string;
  regex?: RegExp;
  /** Set when the pattern was rejected (unsafe regex, invalid syntax) */
  error?: string;
}

/**
 * Normalize filter pattern to support both substring and regex matching.
 * Includes safety checks to prevent catastrophic backtracking from
 * user/LLM-provided regex patterns.
 *
 * When a regex is rejected, returns `{ type: "substring", error: "..." }`
 * so callers can surface the error to the LLM.
 */
export function normalizeFilterPattern(pattern?: string): FilterPatternResult {
  if (!pattern || pattern.trim() === "") return { type: "substring" };
  const trimmed = pattern.trim();
  if (trimmed.startsWith("re:")) {
    const body = trimmed.slice(3);

    // Reject patterns that could cause catastrophic backtracking
    if (isUnsafeRegex(body)) {
      return {
        type: "substring",
        value: body,
        error: `Regex "${body}" rejected: contains nested quantifiers that risk catastrophic backtracking. Use a literal string or simplify the pattern.`,
      };
    }

    try {
      return { type: "regex", regex: new RegExp(body) };
    } catch (e) {
      return {
        type: "substring",
        value: body,
        error: `Invalid regex "${body}": ${toError(e).message}`,
      };
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

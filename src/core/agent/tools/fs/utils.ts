import { FileSystem } from "@effect/platform";
import { Effect } from "effect";

/**
 * Default ignore patterns when .gitignore is missing or empty (matches common VCS/build artifacts).
 */
const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

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
    if (parsed.length === 0) return DEFAULT_IGNORE_PATTERNS;
    return parsed;
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

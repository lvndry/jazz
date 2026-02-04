import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect } from "effect";
import glob from "fast-glob";
import matter from "gray-matter";

export interface NamedIndexItem {
  readonly name: string;
}

export interface ScanMarkdownIndexOptions<T> {
  readonly dir: string;
  readonly fileName: string;
  readonly depth: number;
  readonly ignore?: readonly string[];
  readonly parse: (data: Record<string, unknown>, definitionDir: string) => T | null;
}

/**
 * Scan `dir` for markdown definitions like `SKILL.md` or `WORKFLOW.md` in nested folders,
 * parse frontmatter, and return the resulting index entries.
 *
 * Malformed/unparseable entries are ignored (best-effort).
 */
export function scanMarkdownIndex<T>(
  options: ScanMarkdownIndexOptions<T>,
): Effect.Effect<readonly T[], Error> {
  return Effect.gen(function* () {
    const stat = yield* Effect.tryPromise(() => fs.stat(options.dir)).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );

    if (!stat || !stat.isDirectory()) {
      return [];
    }

    const patterns = [`**/${options.fileName}`];
    const ignore = options.ignore ?? ["**/node_modules/**", "**/.git/**"];

    const matches = yield* Effect.tryPromise(() =>
      glob(patterns, {
        cwd: options.dir,
        deep: options.depth,
        ignore: Array.from(ignore),
        absolute: true,
        caseSensitiveMatch: false,
      }),
    );

    const items: T[] = [];
    for (const match of matches) {
      try {
        const content = yield* Effect.tryPromise(() => fs.readFile(match, "utf-8"));
        const { data } = matter(content);

        const parsed = options.parse(data as Record<string, unknown>, path.dirname(match));
        if (parsed) {
          items.push(parsed);
        }
      } catch {
        // Ignore malformed entries
        continue;
      }
    }

    return items;
  });
}

export interface LoadCachedIndexOptions<T> {
  readonly cachePath: string;
  readonly scan: Effect.Effect<readonly T[], Error>;
}

/**
 * Load a JSON index from `cachePath`, falling back to `scan` and rewriting the cache.
 * Cache rewrite failures are ignored.
 */
export function loadCachedIndex<T>(
  options: LoadCachedIndexOptions<T>,
): Effect.Effect<readonly T[], Error> {
  return Effect.tryPromise(() => fs.readFile(options.cachePath, "utf-8")).pipe(
    Effect.map((content) => JSON.parse(content) as readonly T[]),
    Effect.catchAll(() =>
      Effect.gen(function* () {
        const items = yield* options.scan;

        yield* Effect.promise(() => fs.mkdir(path.dirname(options.cachePath), { recursive: true }))
          .pipe(
            Effect.flatMap(() =>
              Effect.promise(() =>
                fs.writeFile(options.cachePath, JSON.stringify(items, null, 2)),
              ),
            ),
            Effect.catchAll(() => Effect.void),
          );

        return items;
      }),
    ),
  );
}

/**
 * Merge items by `name` with override priority (later arguments win).
 */
export function mergeByName<T extends NamedIndexItem>(
  ...sources: readonly (readonly T[])[]
): readonly T[] {
  const map = new Map<string, T>();
  for (const items of sources) {
    for (const item of items) {
      map.set(item.name, item);
    }
  }
  return Array.from(map.values());
}


/**
 * Shrink-only check for the two checked-in baselines of existing violations:
 * `scripts/no-unknown-casts.baseline.json` and `eslint-suppressions.json`.
 *
 * Each baseline lets today's violations pass so only new ones fail. That only holds if the
 * baseline itself cannot grow in the same change that adds a violation, so this compares the
 * working tree's baselines with the ones at a trusted base revision and fails on any added entry
 * or raised count; entries may only disappear. A baseline missing at the base revision is a first
 * introduction and is skipped. Raising a baseline is a deliberate, reviewed change that lands
 * outside this check (CI runs it on pull requests against the base branch only).
 *
 * Run `bun run verify:baselines-shrink --base-ref <ref>`, e.g. `origin/main`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Counts keyed by a stable `file | detail` label. */
export type FlatCounts = Map<string, number>;

export interface BaselineDefinition {
  path: string;
  flatten: (document: unknown) => FlatCounts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flatten `{ file: { fingerprint: count } }`, the cast baseline's shape.
 * @param document - parsed baseline JSON.
 * @returns counts keyed `file | fingerprint`.
 */
export function flattenCastBaseline(document: unknown): FlatCounts {
  const flat: FlatCounts = new Map();
  if (!isRecord(document)) {
    throw new Error("cast baseline must map file paths to fingerprint counts");
  }
  for (const [file, counts] of Object.entries(document)) {
    for (const [fingerprint, count] of Object.entries(isRecord(counts) ? counts : {})) {
      flat.set(`${file} | ${fingerprint.slice(0, 12)}`, Number(count));
    }
  }
  return flat;
}

/**
 * Flatten `{ file: { rule: { count } } }`, ESLint's bulk-suppressions shape.
 * @param document - parsed suppressions JSON.
 * @returns counts keyed `file | rule`.
 */
export function flattenSuppressions(document: unknown): FlatCounts {
  const flat: FlatCounts = new Map();
  if (!isRecord(document)) {
    throw new Error("suppressions must map file paths to rule counts");
  }
  for (const [file, rules] of Object.entries(document)) {
    for (const [rule, entry] of Object.entries(isRecord(rules) ? rules : {})) {
      const count = isRecord(entry) ? Number(entry["count"]) : Number.NaN;
      flat.set(`${file} | ${rule}`, count);
    }
  }
  return flat;
}

/**
 * Find entries that appear or grow between two baselines.
 * @param base - flattened baseline at the trusted base revision.
 * @param head - flattened baseline in the working tree.
 * @returns one message per added entry or raised count; empty when the baseline only shrank.
 */
export function findBaselineIncreases(base: FlatCounts, head: FlatCounts): string[] {
  const increases: string[] = [];
  for (const [key, headCount] of head) {
    const baseCount = base.get(key);
    if (baseCount === undefined) {
      increases.push(`added: ${key} (${String(headCount)})`);
    } else if (!(headCount <= baseCount)) {
      increases.push(`raised: ${key} (${String(baseCount)} -> ${String(headCount)})`);
    }
  }
  return increases.sort();
}

const BASELINES: BaselineDefinition[] = [
  { path: "scripts/no-unknown-casts.baseline.json", flatten: flattenCastBaseline },
  { path: "eslint-suppressions.json", flatten: flattenSuppressions },
];

function readAtBase(baseRef: string, filePath: string): string | undefined {
  const result = spawnSync("git", ["show", `${baseRef}:${filePath}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return result.stdout;
  }
  if (/exists on disk, but not in|does not exist in|path .* does not exist/u.test(result.stderr)) {
    return undefined;
  }
  throw new Error(
    `verify-baselines-shrink: cannot read ${filePath} at ${baseRef}: ${result.stderr}`,
  );
}

function main(): void {
  const flagIndex = process.argv.indexOf("--base-ref");
  const baseRef = flagIndex === -1 ? undefined : process.argv[flagIndex + 1];
  if (baseRef === undefined) {
    throw new Error("Usage: bun run verify:baselines-shrink --base-ref <ref>");
  }
  const failures: string[] = [];
  for (const baseline of BASELINES) {
    const baseText = readAtBase(baseRef, baseline.path);
    if (baseText === undefined) {
      console.log(`verify-baselines-shrink: ${baseline.path} is new at ${baseRef}; skipped.`);
      continue;
    }
    const increases = findBaselineIncreases(
      baseline.flatten(JSON.parse(baseText)),
      baseline.flatten(JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, baseline.path), "utf8"))),
    );
    failures.push(...increases.map((increase) => `  ${baseline.path}: ${increase}`));
  }
  if (failures.length > 0) {
    throw new Error(
      `verify-baselines-shrink: a baseline grew relative to ${baseRef}. Fix the new violation instead of recording it; raising a baseline is a deliberate, reviewed change.\n${failures.join("\n")}`,
    );
  }
  console.log(`verify-baselines-shrink: baselines only shrank relative to ${baseRef}.`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

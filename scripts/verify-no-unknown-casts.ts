/**
 * Ratchet on type assertions to `unknown` (`value as unknown`, `<unknown>value`, and unions that
 * contain `unknown`). Existing assertions are recorded in `scripts/no-unknown-casts.baseline.json`;
 * a new one fails the check, and a removed one must be pruned so the allowance only shrinks.
 *
 * Run `bun run verify:unknown-casts`, or add `--prune` after removing casts to drop their entries.
 * `--init` writes a first baseline and refuses to overwrite one; `--rebaseline` overwrites it and
 * is a deliberate, reviewed change. `scripts/verify-baselines-shrink.ts` compares the baseline with
 * the base branch's in CI, so adding an entry or raising a count fails there.
 * Entries are keyed by file and a hash of the assertion's tokens rather than by line, so moving
 * code or rebasing never invalidates the baseline.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "scripts/no-unknown-casts.baseline.json";
const SCAN_AREAS = ["packages/", "plugins/", "scripts/", "evals/", "bench/"];
const EXCLUDED_PREFIXES = ["vendor/", "packages/website/"];
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Existing assertion counts, keyed by repository path and token fingerprint. */
export type UnknownCastBaseline = Record<string, Record<string, number>>;

export interface UnknownCast {
  /** Repository-relative path with forward slashes. */
  file: string;
  /** One-based line of the asserted type. */
  line: number;
  /** SHA-256 of the assertion's tokens, excluding comments and whitespace. */
  fingerprint: string;
}

export interface UnknownCastReport {
  total: number;
  added: UnknownCast[];
  stale: string[];
}

function tokenFingerprint(node: ts.Node, source: ts.SourceFile): string {
  const tokens: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isJSDoc(child)) {
      return;
    }
    if (ts.isToken(child)) {
      tokens.push(child.getText(source));
    } else {
      child.getChildren(source).forEach(visit);
    }
  };
  visit(node);
  return createHash("sha256").update(JSON.stringify(tokens)).digest("hex");
}

function assertsUnknown(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) {
    return assertsUnknown(type.type);
  }
  return (
    type.kind === ts.SyntaxKind.UnknownKeyword ||
    (ts.isUnionTypeNode(type) && type.types.some(assertsUnknown))
  );
}

/**
 * Find assertions to `unknown` in one source file.
 * @param file - repository-relative path; its extension selects TS or TSX parsing.
 * @param text - source contents.
 * @returns assertions in traversal order; comments, strings and `unknown` used as a type argument do not match.
 */
export function findUnknownCasts(file: string, text: string): UnknownCast[] {
  const normalized = file.replaceAll("\\", "/");
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true);
  const casts: UnknownCast[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      assertsUnknown(node.type)
    ) {
      casts.push({
        file: normalized,
        line: source.getLineAndCharacterOfPosition(node.type.getStart(source)).line + 1,
        fingerprint: tokenFingerprint(node, source),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return casts;
}

function isScannedSource(file: string): boolean {
  return (
    /\.[cm]?[jt]sx?$/u.test(file) &&
    SCAN_AREAS.some((area) => file.startsWith(area)) &&
    !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

/**
 * Scan tracked and non-ignored new source, tests and scripts included.
 * @param repositoryRoot - repository root holding the git index.
 * @returns every assertion to `unknown` in the working tree.
 * @throws when discovery returns no file under a required area.
 */
export function scanUnknownCasts(repositoryRoot: string): UnknownCast[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
  );
  const files = [...new Set(listed.split("\0").filter(isScannedSource))].sort();
  for (const area of ["packages/", "scripts/"]) {
    if (!files.some((file) => file.startsWith(area))) {
      throw new Error(`verify-no-unknown-casts: source discovery omitted ${area}`);
    }
  }
  return files.flatMap((file) => {
    let text: string;
    try {
      text = readFileSync(path.resolve(repositoryRoot, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(
        `verify-no-unknown-casts: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return findUnknownCasts(file, text);
  });
}

/**
 * Tally assertions per file and fingerprint.
 * @param casts - observed assertions.
 * @returns counts in stable order for comparison and writing.
 */
export function countUnknownCasts(casts: readonly UnknownCast[]): UnknownCastBaseline {
  const baseline: UnknownCastBaseline = {};
  for (const { file, fingerprint } of casts) {
    const counts = (baseline[file] ??= {});
    counts[fingerprint] = (counts[fingerprint] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(baseline)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, counts]) => [
        file,
        Object.fromEntries(
          Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ]),
  );
}

function readBaseline(repositoryRoot: string): UnknownCastBaseline {
  const parsed: unknown = JSON.parse(
    readFileSync(path.resolve(repositoryRoot, BASELINE_PATH), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("verify-no-unknown-casts: baseline must map file paths to fingerprint counts");
  }
  return parsed as UnknownCastBaseline;
}

/**
 * Compare observed assertions with a recorded baseline.
 * @param casts - assertions found in the working tree.
 * @param baseline - allowance recorded in the checked-in baseline.
 * @returns the total, assertions the baseline does not cover, and baseline entries no longer present.
 */
export function compareUnknownCasts(
  casts: readonly UnknownCast[],
  baseline: UnknownCastBaseline,
): UnknownCastReport {
  const remaining = structuredClone(baseline);
  const added: UnknownCast[] = [];
  for (const cast of casts) {
    const counts = remaining[cast.file];
    const allowance = counts?.[cast.fingerprint] ?? 0;
    if (counts !== undefined && allowance > 0) {
      counts[cast.fingerprint] = allowance - 1;
    } else {
      added.push(cast);
    }
  }
  const stale = Object.entries(remaining).flatMap(([file, counts]) =>
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([fingerprint]) => `${file} (${fingerprint.slice(0, 12)})`),
  );
  return { total: casts.length, added, stale };
}

function writeBaseline(casts: readonly UnknownCast[]): void {
  writeFileSync(
    path.resolve(REPOSITORY_ROOT, BASELINE_PATH),
    `${JSON.stringify(countUnknownCasts(casts), null, 2)}\n`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--prune" && arg !== "--init" && arg !== "--rebaseline")) {
    throw new Error("Usage: bun run verify:unknown-casts [--prune | --init | --rebaseline]");
  }
  const casts = scanUnknownCasts(REPOSITORY_ROOT);
  const baselineExists = existsSync(path.resolve(REPOSITORY_ROOT, BASELINE_PATH));
  if (args.includes("--init") && baselineExists) {
    throw new Error(
      "verify-no-unknown-casts: a baseline already exists; --init will not overwrite it. Raising it is a deliberate, reviewed change: use --rebaseline.",
    );
  }
  if (args.includes("--init") || args.includes("--rebaseline")) {
    writeBaseline(casts);
    console.log(
      `verify-no-unknown-casts: baseline written with ${String(casts.length)} assertions.`,
    );
    return;
  }
  const { total, added, stale } = compareUnknownCasts(casts, readBaseline(REPOSITORY_ROOT));
  if (added.length > 0) {
    throw new Error(
      "verify-no-unknown-casts: new assertions to unknown are forbidden. Use a typed value or narrow the input.\n" +
        added.map((cast) => `  ${cast.file}:${String(cast.line)}`).join("\n"),
    );
  }
  if (stale.length > 0) {
    if (!args.includes("--prune")) {
      throw new Error(
        "verify-no-unknown-casts: assertions were removed; record that with `bun run verify:unknown-casts --prune`.\n" +
          stale.map((entry) => `  ${entry}`).join("\n"),
      );
    }
    writeBaseline(casts);
  }
  console.log(
    `verify-no-unknown-casts: no new assertions; ${String(total)} existing assertions remain.`,
  );
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * Zero-tolerance check for assertion escape hatches. It fails on:
 *
 * - an assertion to `unknown` (`value as unknown`, `<unknown>value`, or a union containing it);
 * - a double assertion through a non-specific type: `value as object as T`, `as {} as T`,
 *   `as never as T`, `as any as T` and `as unknown as T` all launder one type into another
 *   without the compiler checking the relationship, exactly like `as unknown as T`.
 *
 * A single `as T` is allowed, as is `as const`. The test-support helpers that hold one documented
 * plain `as T` each (the typed fakes under `plugins/jev/tests/` and the per-package test helpers
 * named in their own docstrings) are single assertions, so they pass without an exception list.
 *
 * Run `bun run verify:unknown-casts`; the output lists each offending `file:line` with the kind.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_AREAS = ["packages/", "plugins/", "scripts/", "evals/", "bench/"];
const EXCLUDED_PREFIXES = ["vendor/", "packages/website/"];
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

export type CastKind = "unknown-assertion" | "double-assertion";

export interface UnsafeCast {
  /** Repository-relative path with forward slashes. */
  file: string;
  /** One-based line of the asserted type. */
  line: number;
  kind: CastKind;
}

function unwrapParentheses(type: ts.TypeNode): ts.TypeNode {
  return ts.isParenthesizedTypeNode(type) ? unwrapParentheses(type.type) : type;
}

function assertsUnknown(type: ts.TypeNode): boolean {
  const inner = unwrapParentheses(type);
  return (
    inner.kind === ts.SyntaxKind.UnknownKeyword ||
    (ts.isUnionTypeNode(inner) && inner.types.some(assertsUnknown))
  );
}

function isNonSpecificType(type: ts.TypeNode): boolean {
  const inner = unwrapParentheses(type);
  return (
    inner.kind === ts.SyntaxKind.UnknownKeyword ||
    inner.kind === ts.SyntaxKind.AnyKeyword ||
    inner.kind === ts.SyntaxKind.NeverKeyword ||
    inner.kind === ts.SyntaxKind.ObjectKeyword ||
    (ts.isTypeLiteralNode(inner) && inner.members.length === 0) ||
    (ts.isTypeReferenceNode(inner) &&
      ts.isIdentifier(inner.typeName) &&
      inner.typeName.text === "Object" &&
      inner.typeArguments === undefined)
  );
}

function isAssertion(node: ts.Node): node is ts.AsExpression | ts.TypeAssertion {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node);
}

function isConstAssertion(type: ts.TypeNode): boolean {
  return (
    ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "const"
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? unwrapExpression(expression.expression)
    : expression;
}

/**
 * Find assertion escape hatches in one source file.
 * @param file - repository-relative path; its extension selects TS or TSX parsing.
 * @param text - source contents.
 * @returns offending assertions in traversal order. `as unknown as T` is reported twice: the inner assertion to `unknown`, and the outer double assertion.
 */
export function findUnsafeCasts(file: string, text: string): UnsafeCast[] {
  const normalized = file.replaceAll("\\", "/");
  const source = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true);
  const casts: UnsafeCast[] = [];
  const report = (node: ts.AsExpression | ts.TypeAssertion, kind: CastKind): void => {
    casts.push({
      file: normalized,
      line: source.getLineAndCharacterOfPosition(node.type.getStart(source)).line + 1,
      kind,
    });
  };
  const visit = (node: ts.Node): void => {
    if (isAssertion(node)) {
      const operand = unwrapExpression(node.expression);
      if (assertsUnknown(node.type)) {
        report(node, "unknown-assertion");
      } else if (
        !isConstAssertion(node.type) &&
        isAssertion(operand) &&
        isNonSpecificType(operand.type)
      ) {
        report(node, "double-assertion");
      }
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
 * @returns every offending assertion in the working tree.
 * @throws when discovery returns no file under a required area, or a file cannot be read for a reason other than having been deleted.
 */
export function scanUnsafeCasts(repositoryRoot: string): UnsafeCast[] {
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
    return findUnsafeCasts(file, text);
  });
}

function main(): void {
  const casts = scanUnsafeCasts(REPOSITORY_ROOT);
  if (casts.length > 0) {
    throw new Error(
      "verify-no-unknown-casts: assertions through unknown, any, never, object or {} are forbidden. Use a typed value, narrow the input, or validate it at the boundary.\n" +
        casts.map((cast) => `  ${cast.file}:${String(cast.line)} (${cast.kind})`).join("\n"),
    );
  }
  console.log("verify-no-unknown-casts: no assertion escape hatches.");
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

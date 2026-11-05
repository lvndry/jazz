/**
 * Reads a store's shape and version out of the source files that define them, with the
 * TypeScript compiler. A declaration's shape is its printed text with comments and the `export`
 * modifier removed, so formatting, documentation and visibility changes are not shape changes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  hashDeclarations,
  type StoreDeclarations,
  type StoreShape,
  type StoreVersion,
} from "./persistence-gate";
import type { DeclarationReference, PersistedStore, VersionSource } from "./persistence-registry";

const REPOSITORY_ROOT = path.join(import.meta.dir, "..");
const EXPORT_MODIFIER_PREFIX = /^export\s+/;

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const sourceFileCache = new Map<string, ts.SourceFile>();

function loadSourceFile(file: string): ts.SourceFile {
  const cached = sourceFileCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const text = readFileSync(path.join(REPOSITORY_ROOT, file), "utf-8");
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  sourceFileCache.set(file, sourceFile);
  return sourceFile;
}

function declaresSymbol(statement: ts.Statement, symbol: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === symbol,
    );
  }
  if (
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    return statement.name?.text === symbol;
  }
  return false;
}

function requireDeclaration(reference: DeclarationReference): {
  readonly sourceFile: ts.SourceFile;
  readonly statement: ts.Statement;
} {
  const sourceFile = loadSourceFile(reference.file);
  const statement = sourceFile.statements.find((candidate) =>
    declaresSymbol(candidate, reference.symbol),
  );
  if (statement === undefined) {
    throw new Error(
      `${reference.file} has no top-level declaration named ${reference.symbol}. Update scripts/persistence-registry.ts.`,
    );
  }
  return { sourceFile, statement };
}

export function declarationLines(reference: DeclarationReference): readonly string[] {
  const { sourceFile, statement } = requireDeclaration(reference);
  const printed = printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile);
  return printed.replace(EXPORT_MODIFIER_PREFIX, "").split("\n");
}

function literalNumber(node: ts.Node | undefined): number | undefined {
  if (node === undefined) {
    return undefined;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (ts.isLiteralTypeNode(node)) {
    return literalNumber(node.literal);
  }
  if (ts.isAsExpression(node)) {
    return literalNumber(node.expression);
  }
  if (ts.isCallExpression(node) && node.arguments.length === 1) {
    return literalNumber(node.arguments[0]);
  }
  return undefined;
}

function findPropertyNumber(root: ts.Node, property: string): number | undefined {
  let found: number | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) {
      return;
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) &&
      node.name.getText() === property
    ) {
      found = literalNumber(ts.isPropertyAssignment(node) ? node.initializer : node.type);
    }
    if (found === undefined) {
      ts.forEachChild(node, visit);
    }
  };
  visit(root);
  return found;
}

function constantNumber(statement: ts.Statement, symbol: string): number | undefined {
  if (!ts.isVariableStatement(statement)) {
    return undefined;
  }
  const declaration = statement.declarationList.declarations.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === symbol,
  );
  return literalNumber(declaration?.initializer);
}

export function describeVersionSource(source: VersionSource): string {
  if (source.kind === "unversioned") {
    return `the store's format version (it has none today: ${source.reason})`;
  }
  if (source.kind === "constant") {
    return `${source.symbol} in ${source.file}`;
  }
  return `\`${source.property}\` of ${source.symbol} in ${source.file}`;
}

export function readVersion(source: VersionSource): StoreVersion {
  if (source.kind === "unversioned") {
    return "unversioned";
  }
  const { statement } = requireDeclaration(source);
  const value =
    source.kind === "constant"
      ? constantNumber(statement, source.symbol)
      : findPropertyNumber(statement, source.property);
  if (value === undefined) {
    throw new Error(
      `Could not read a numeric version from ${describeVersionSource(source)}. Update scripts/persistence-registry.ts.`,
    );
  }
  return value;
}

export function readLiveShape(store: PersistedStore): StoreShape {
  const declarations: Record<string, readonly string[]> = {};
  for (const reference of store.declarations) {
    declarations[`${reference.file}#${reference.symbol}`] = declarationLines(reference);
  }
  const frozen: StoreDeclarations = declarations;
  return {
    version: readVersion(store.version),
    shape: hashDeclarations(frozen),
    declarations: frozen,
  };
}

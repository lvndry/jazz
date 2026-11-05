/**
 * Allowed-imports matrix for every workspace package and plugin.
 *
 * `scripts/package-layering.matrix.json` lists, per package, the workspace packages its
 * production code may import (`imports`) and the extra ones its tests may import (`testImports`).
 * Plugins form one row: they import `@jazz/plugin-sdk` and nothing else, so they stay publishable
 * against the SDK alone. `eslint.config.mjs` generates its `no-restricted-imports` rules from the
 * same file, so editors flag a bad import as it is typed; this test also covers relative imports
 * that cross a package boundary and the dependencies each package.json declares.
 *
 * A package missing from the matrix fails, so adding one forces a decision about where it sits.
 * An existing violation that cannot be fixed yet goes in `KNOWN_VIOLATIONS` with what must change;
 * the list only shrinks, and an entry that no longer matches fails the test.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const REPOSITORY_ROOT = path.join(import.meta.dir, "..");
const PACKAGES_ROOT = path.join(REPOSITORY_ROOT, "packages");
const PLUGINS_ROOT = path.join(REPOSITORY_ROOT, "plugins");

interface MatrixRow {
  imports: string[];
  testImports?: string[];
}

interface Matrix {
  packages: Record<string, MatrixRow>;
  plugins: MatrixRow;
}

const matrix = JSON.parse(
  readFileSync(path.join(import.meta.dir, "package-layering.matrix.json"), "utf8"),
) as Matrix;

/**
 * Violations that exist today, as `<file> -> <target package>`, each with what must change before
 * the entry can be deleted. Empty: every current import passes the matrix.
 */
const KNOWN_VIOLATIONS: Record<string, string> = {};

const WORKSPACE_SPECIFIER = /^@jazz\/([a-z-]+)(\/|$)/;
const ALIAS_SPECIFIER = /^@\/([a-z-]+)\//;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (entry === "node_modules" || entry === "dist") {
      continue;
    }
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function workspacePackages(): string[] {
  return readdirSync(PACKAGES_ROOT).filter(
    (entry) =>
      statSync(path.join(PACKAGES_ROOT, entry)).isDirectory() &&
      existsSync(path.join(PACKAGES_ROOT, entry, "package.json")),
  );
}

function pluginDirectories(): string[] {
  return readdirSync(PLUGINS_ROOT).filter((entry) =>
    existsSync(path.join(PLUGINS_ROOT, entry, "package.json")),
  );
}

function targetPackage(file: string, specifier: string): string | undefined {
  const workspace = WORKSPACE_SPECIFIER.exec(specifier) ?? ALIAS_SPECIFIER.exec(specifier);
  if (workspace) {
    return workspace[1];
  }
  if (specifier.startsWith(".")) {
    const relative = path
      .relative(REPOSITORY_ROOT, path.resolve(path.dirname(file), specifier))
      .split(path.sep);
    if (relative[0] === "packages") {
      return relative[1];
    }
  }
  return undefined;
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

function allowedTargets(row: MatrixRow, testFile: boolean): Set<string> {
  return new Set([...row.imports, ...(testFile ? (row.testImports ?? []) : [])]);
}

function violations(): string[] {
  const found: string[] = [];
  const units: { name: string; root: string; row: MatrixRow }[] = [
    ...workspacePackages().map((name) => ({
      name,
      root: path.join(PACKAGES_ROOT, name),
      row: matrix.packages[name] ?? { imports: [] },
    })),
    ...pluginDirectories().map((name) => ({
      name: `plugins/${name}`,
      root: path.join(PLUGINS_ROOT, name),
      row: matrix.plugins,
    })),
  ];
  for (const unit of units) {
    const selfName = unit.name.startsWith("plugins/") ? undefined : unit.name;
    for (const file of sourceFiles(unit.root)) {
      const allowed = allowedTargets(unit.row, isTestFile(file));
      const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
      for (const imported of imports) {
        const target = targetPackage(file, imported.fileName);
        if (target !== undefined && target !== selfName && !allowed.has(target)) {
          found.push(`${path.relative(REPOSITORY_ROOT, file)} -> ${target}`);
        }
      }
    }
  }
  return found.sort();
}

describe("package layering matrix", () => {
  it("has a row for every workspace package", () => {
    expect(workspacePackages().sort()).toEqual(Object.keys(matrix.packages).sort());
  });

  it("only names packages that exist", () => {
    const known = new Set(workspacePackages());
    const named = [...Object.values(matrix.packages), matrix.plugins].flatMap((row) => [
      ...row.imports,
      ...(row.testImports ?? []),
    ]);
    expect(named.filter((name) => !known.has(name))).toEqual([]);
  });

  it("lets plugins import only plugin-sdk", () => {
    expect(matrix.plugins).toEqual({ imports: ["plugin-sdk"] });
  });

  it("keeps the matrix acyclic", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];
    const visit = (name: string, trail: string[]): void => {
      if (done.has(name)) {
        return;
      }
      if (visiting.has(name)) {
        cycles.push([...trail, name].join(" -> "));
        return;
      }
      visiting.add(name);
      for (const next of matrix.packages[name]?.imports ?? []) {
        visit(next, [...trail, name]);
      }
      visiting.delete(name);
      done.add(name);
    };
    for (const name of Object.keys(matrix.packages)) {
      visit(name, []);
    }
    expect(cycles).toEqual([]);
  });

  it("keeps every import inside the matrix", () => {
    const unexpected = violations().filter((entry) => !(entry in KNOWN_VIOLATIONS));
    expect(unexpected).toEqual([]);
  });

  it("drops known violations once they are fixed", () => {
    const current = new Set(violations());
    const stale = Object.keys(KNOWN_VIOLATIONS).filter((entry) => !current.has(entry));
    expect(stale).toEqual([]);
  });

  it("declares only matrix-allowed workspace dependencies", () => {
    const offending: string[] = [];
    const manifests = [
      ...workspacePackages().map((name) => ({
        name,
        file: path.join(PACKAGES_ROOT, name, "package.json"),
        row: matrix.packages[name] ?? { imports: [] },
      })),
      ...pluginDirectories().map((name) => ({
        name: `plugins/${name}`,
        file: path.join(PLUGINS_ROOT, name, "package.json"),
        row: matrix.plugins,
      })),
    ];
    for (const { name, file, row } of manifests) {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          const target = /^@jazz\/(.+)$/.exec(dependency)?.[1];
          if (target !== undefined && !allowedTargets(row, false).has(target)) {
            offending.push(`${name} ${field} ${dependency}`);
          }
        }
      }
      for (const dependency of Object.keys(manifest["devDependencies"] ?? {})) {
        const target = /^@jazz\/(.+)$/.exec(dependency)?.[1];
        if (target !== undefined && !allowedTargets(row, true).has(target)) {
          offending.push(`${name} devDependencies ${dependency}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});

/**
 * Allowed-imports matrix for every workspace package and plugin.
 *
 * `scripts/package-layering.matrix.json` lists, per package, the workspace packages its
 * production code may import (`imports`) and the extra ones its tests may import (`testImports`).
 * Plugins form one row: they import `@jazz/plugin-sdk` and nothing else (not another
 * `@jazz-plugin/*` package either), so they stay publishable against the SDK alone.
 * `eslint.config.mjs` generates its `no-restricted-imports` rules from the same file, so editors
 * flag a bad import as it is typed; this test also covers relative imports that cross a package
 * boundary and the dependencies each package.json declares.
 *
 * A package missing from the matrix fails, so adding one forces a decision about where it sits.
 * An existing violation that cannot be fixed yet goes in `KNOWN_VIOLATIONS` with what must change;
 * the list only shrinks, and an entry that no longer matches fails the test.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { importTargetKey, workspaceScopes, type WorkspaceNames } from "./package-layering";

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

interface Unit {
  key: string;
  root: string;
  manifestPath: string;
  row: MatrixRow;
}

const matrix = JSON.parse(
  readFileSync(path.join(import.meta.dir, "package-layering.matrix.json"), "utf8"),
) as Matrix;

/**
 * Violations that exist today, as `<file> -> <target unit>`, each with what must change before
 * the entry can be deleted. Empty: every current import passes the matrix.
 */
const KNOWN_VIOLATIONS: Record<string, string> = {};

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

function directoriesWithManifest(root: string): string[] {
  return readdirSync(root).filter((entry) => existsSync(path.join(root, entry, "package.json")));
}

function workspacePackages(): string[] {
  return directoriesWithManifest(PACKAGES_ROOT);
}

function units(): Unit[] {
  return [
    ...workspacePackages().map((name) => ({
      key: name,
      root: path.join(PACKAGES_ROOT, name),
      manifestPath: path.join(PACKAGES_ROOT, name, "package.json"),
      row: matrix.packages[name] ?? { imports: [] },
    })),
    ...directoriesWithManifest(PLUGINS_ROOT).map((name) => ({
      key: `plugins/${name}`,
      root: path.join(PLUGINS_ROOT, name),
      manifestPath: path.join(PLUGINS_ROOT, name, "package.json"),
      row: matrix.plugins,
    })),
  ];
}

function workspaceNames(): WorkspaceNames {
  const names = new Map<string, string>();
  for (const unit of units()) {
    const manifest = JSON.parse(readFileSync(unit.manifestPath, "utf8")) as { name: string };
    names.set(manifest.name, unit.key);
  }
  return names;
}

function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/.test(file);
}

function allowedTargets(row: MatrixRow, testFile: boolean): Set<string> {
  return new Set([...row.imports, ...(testFile ? (row.testImports ?? []) : [])]);
}

/**
 * Whether a unit may import a specifier.
 * @param row - the unit's matrix row.
 * @param unitKey - the unit's own key; importing itself is always fine.
 * @param specifier - the import specifier as written.
 * @returns the offending unit key, or undefined when the import is allowed.
 */
function offendingTarget(
  row: MatrixRow,
  unitKey: string,
  specifier: string,
  testFile: boolean,
  names: WorkspaceNames,
): string | undefined {
  const target = importTargetKey(
    specifier,
    names,
    path.join(REPOSITORY_ROOT, "x.ts"),
    REPOSITORY_ROOT,
  );
  if (target === undefined || target === unitKey || allowedTargets(row, testFile).has(target)) {
    return undefined;
  }
  return target;
}

function violations(): string[] {
  const found: string[] = [];
  const names = workspaceNames();
  for (const unit of units()) {
    for (const file of sourceFiles(unit.root)) {
      const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
      for (const imported of imports) {
        const target = importTargetKey(imported.fileName, names, file, REPOSITORY_ROOT);
        if (
          target !== undefined &&
          target !== unit.key &&
          !allowedTargets(unit.row, isTestFile(file)).has(target)
        ) {
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
    const names = workspaceNames();
    const scopes = workspaceScopes(names.keys());
    for (const unit of units()) {
      const manifest = JSON.parse(readFileSync(unit.manifestPath, "utf8")) as Record<
        string,
        Record<string, string> | undefined
      >;
      for (const field of [
        "dependencies",
        "peerDependencies",
        "optionalDependencies",
        "devDependencies",
      ]) {
        for (const dependency of Object.keys(manifest[field] ?? {})) {
          const scope = dependency.split("/")[0] ?? "";
          if (!scopes.has(scope)) {
            continue;
          }
          const target = offendingTarget(
            unit.row,
            unit.key,
            dependency,
            field === "devDependencies",
            names,
          );
          if (target !== undefined) {
            offending.push(`${unit.key} ${field} ${dependency}`);
          }
        }
      }
    }
    expect(offending).toEqual([]);
  });
});

describe("import resolution", () => {
  const names: WorkspaceNames = new Map([
    ["@jazz/plugin-sdk", "plugin-sdk"],
    ["@jazz/core", "core"],
    ["@jazz-plugin/jev", "plugins/jev"],
    ["@jazz-plugin/lsp", "plugins/lsp"],
  ]);
  const pluginRow = matrix.plugins;
  const importer = path.join(REPOSITORY_ROOT, "plugins/lsp/src/index.ts");

  it("rejects a plugin importing another plugin by package name", () => {
    expect(importTargetKey("@jazz-plugin/jev", names, importer, REPOSITORY_ROOT)).toBe(
      "plugins/jev",
    );
    expect(offendingTarget(pluginRow, "plugins/lsp", "@jazz-plugin/jev", false, names)).toBe(
      "plugins/jev",
    );
  });

  it("rejects a plugin importing a workspace-scope package that does not exist", () => {
    expect(
      offendingTarget(pluginRow, "plugins/lsp", "@jazz-plugin/missing/sub", false, names),
    ).toBe("@jazz-plugin/missing");
  });

  it("rejects a plugin importing another plugin by relative path", () => {
    expect(importTargetKey("../../jev/src/index", names, importer, REPOSITORY_ROOT)).toBe(
      "plugins/jev",
    );
  });

  it("lets a plugin import plugin-sdk and its own package", () => {
    expect(offendingTarget(pluginRow, "plugins/lsp", "@jazz/plugin-sdk", false, names)).toBe(
      undefined,
    );
    expect(offendingTarget(pluginRow, "plugins/lsp", "@jazz-plugin/lsp", false, names)).toBe(
      undefined,
    );
  });

  it("rejects a plugin importing core", () => {
    expect(offendingTarget(pluginRow, "plugins/lsp", "@jazz/core/utils", false, names)).toBe(
      "core",
    );
  });

  it("ignores third-party packages", () => {
    expect(importTargetKey("@scope/other", names, importer, REPOSITORY_ROOT)).toBe(undefined);
    expect(importTargetKey("effect", names, importer, REPOSITORY_ROOT)).toBe(undefined);
  });
});

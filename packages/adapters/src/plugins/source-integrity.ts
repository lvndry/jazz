/**
 * Pins the code a plugin runs to the digest the operator trusted.
 *
 * A digest covers a directory: an installed source tree, or the digest-addressed directory holding a
 * packed `plugin.mjs`. Both are useless as a pin if the imported module can reach code outside that
 * directory, so {@link scanPluginImportGraph} walks every static import, re-export, `require`, and
 * literal dynamic import from the entry and refuses any specifier that does not resolve to a file
 * inside the directory. Node and Bun built-ins are the only exception. Package imports resolve
 * through `node_modules` directories that are never hashed, so they are refused too; the plugin SDK
 * is types-only and must be imported with `import type`, which leaves no runtime import behind.
 *
 * The scan uses `Bun.Transpiler.scanImports`, which parses without evaluating: Bun macros and other
 * install-time code never run. Imports are scanned conservatively (no unused-import trimming), so a
 * TypeScript import that the runtime would elide still has to resolve inside the tree.
 *
 * {@link verifySourceInstall} is the one check the loader and `inspect` share for a source install:
 * the entry is a safe relative path whose real location is a regular file inside the tree, the tree
 * still hashes to its digest, and its import graph stays inside the tree.
 */

import * as fs from "node:fs/promises";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import { toError } from "@jazz/core/utils/errors";
import { hashSourceTree } from "./github-source";
import { parsePluginSourceEntry } from "./manifest-schema";

/** The plugin SDK's package name. It is types-only, so plugins import it with `import type`. */
export const PLUGIN_SDK_SPECIFIER = "@jazz/plugin-sdk";

const BUILTIN_PREFIX = /^(?:node:|bun:)/;

type ScanLoader = "ts" | "jsx" | "tsx";

/**
 * Loaders for files whose imports are scanned. JavaScript is scanned as JSX because Bun accepts JSX
 * in `.js` files, and the JSX runtime import it implies is itself a package import.
 */
const SCAN_LOADERS: Readonly<Record<string, ScanLoader>> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "jsx",
  ".mjs": "jsx",
  ".cjs": "jsx",
  ".jsx": "jsx",
};

/** True for a Node or Bun built-in module specifier, which resolves inside the runtime itself. */
export function isRuntimeBuiltin(specifier: string): boolean {
  return BUILTIN_PREFIX.test(specifier) || isBuiltin(specifier);
}

/** True when `child` is `parent` or lies beneath it. Both paths must already be resolved. */
export function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** A specifier that names a package (or an alias) rather than a relative, absolute, or URL path. */
function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !path.isAbsolute(specifier) && !/^[a-z]+:/i.test(specifier);
}

function packageRefusal(importer: string, specifier: string, cause: unknown): Error {
  return new Error(
    `plugin file ${importer} imports package ${specifier}; packages resolve from node_modules, which the trusted digest does not cover, so bundle them with \`jazz plugin pack\``,
    { cause },
  );
}

/** Resolve `specifier` the way the runtime does from `importerFile` and require a file in the tree. */
async function resolveImportWithin(
  realRoot: string,
  importerFile: string,
  specifier: string,
): Promise<string> {
  const importer = relativeLabel(realRoot, importerFile);
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, path.dirname(importerFile));
  } catch (error) {
    if (isPackageSpecifier(specifier)) {
      throw packageRefusal(importer, specifier, error);
    }
    throw new Error(`plugin file ${importer} imports ${specifier}, which does not resolve`, {
      cause: error,
    });
  }
  try {
    return await realFileWithin(realRoot, resolved, `plugin file ${importer} import ${specifier}`);
  } catch (error) {
    if (isPackageSpecifier(specifier)) {
      throw packageRefusal(importer, specifier, error);
    }
    throw error;
  }
}

function relativeLabel(realRoot: string, file: string): string {
  return path.relative(realRoot, file) || path.basename(file);
}

async function realFileWithin(realRoot: string, candidate: string, label: string): Promise<string> {
  const real = await fs.realpath(candidate).catch(() => undefined);
  if (real === undefined) {
    throw new Error(`${label} does not exist`);
  }
  if (!isPathWithin(realRoot, real)) {
    throw new Error(`${label} resolves outside the plugin directory`);
  }
  const status = await fs.lstat(real);
  if (!status.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  return real;
}

/**
 * Walk the import graph from `entry` (relative to `root`) and throw on the first import that is
 * neither a runtime built-in nor a file inside `root`. Returns every visited file, relative to the
 * real root, in discovery order.
 */
export async function scanPluginImportGraph(
  root: string,
  entry: string,
): Promise<readonly string[]> {
  const realRoot = await fs.realpath(root);
  const entryFile = await realFileWithin(
    realRoot,
    path.join(realRoot, entry),
    `plugin entry ${entry}`,
  );
  const transpilers = new Map<ScanLoader, Bun.Transpiler>();
  const visited = new Set<string>([entryFile]);
  const pending = [entryFile];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const loader = SCAN_LOADERS[path.extname(file).toLowerCase()];
    if (loader === undefined) {
      continue;
    }
    let transpiler = transpilers.get(loader);
    if (transpiler === undefined) {
      transpiler = new Bun.Transpiler({ loader });
      transpilers.set(loader, transpiler);
    }
    const importer = relativeLabel(realRoot, file);
    let imports: ReturnType<Bun.Transpiler["scanImports"]>;
    try {
      imports = transpiler.scanImports(await fs.readFile(file, "utf8"));
    } catch (error) {
      throw new Error(`plugin file ${importer} cannot be parsed: ${toError(error).message}`, {
        cause: error,
      });
    }
    for (const imported of imports) {
      const specifier = imported.path;
      if (isRuntimeBuiltin(specifier)) {
        continue;
      }
      if (specifier === PLUGIN_SDK_SPECIFIER || specifier.startsWith(`${PLUGIN_SDK_SPECIFIER}/`)) {
        throw new Error(
          `plugin file ${importer} imports ${specifier} at runtime; import the SDK with \`import type\``,
        );
      }
      const target = await resolveImportWithin(realRoot, file, specifier);
      if (!visited.has(target)) {
        visited.add(target);
        pending.push(target);
      }
    }
  }
  return [...visited].map((file) => relativeLabel(realRoot, file));
}

export interface SourceInstallLocation {
  /** The digest-addressed root of the installed source tree. */
  readonly sourceRoot: string;
  /** The manifest's entry path, relative to `sourceRoot`. */
  readonly entry: string;
  /** The trusted source-tree digest. */
  readonly digest: string;
  /** The path the state record will import. */
  readonly artifactPath: string;
}

/**
 * Throw unless an installed source tree still is exactly what was trusted: the entry is a safe
 * relative path, the recorded import path is that entry under the digest-addressed root, the tree
 * hashes to its digest with no symlink or special file, and its import graph stays inside the tree.
 */
export async function verifySourceInstall(location: SourceInstallLocation): Promise<void> {
  const entry = parsePluginSourceEntry(location.entry);
  if (location.artifactPath !== path.join(location.sourceRoot, entry)) {
    throw new Error("source entry is not digest-addressed");
  }
  let actual: string;
  try {
    actual = await hashSourceTree(location.sourceRoot);
  } catch (error) {
    throw new Error(
      `source tree is missing or failed digest verification: ${toError(error).message}`,
      { cause: error },
    );
  }
  if (actual !== location.digest) {
    throw new Error("source tree is missing or failed digest verification");
  }
  await scanPluginImportGraph(location.sourceRoot, entry);
}

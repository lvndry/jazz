/**
 * Resolves import specifiers to workspace units for the layering matrix test.
 *
 * A unit key is the directory name for `packages/<name>` (`core`, `plugin-sdk`) and
 * `plugins/<name>` for a plugin. Workspace package names span several scopes (`@jazz/*` for
 * packages, `@jazz-plugin/*` for plugins), so the scopes are derived from the workspaces'
 * package.json names rather than listed here; a specifier in any workspace scope resolves to a
 * unit, and one that names a missing package in a workspace scope still resolves (to its package
 * name) so it is reported instead of ignored.
 */

import path from "node:path";

/** Workspace package name to unit key, e.g. `@jazz-plugin/jev` to `plugins/jev`. */
export type WorkspaceNames = ReadonlyMap<string, string>;

const SCOPED_NAME = /^(@[^/]+)\/([^/]+)/;
const ALIAS_SPECIFIER = /^@\/([a-z-]+)\//;

/**
 * Collect the scopes (`@jazz`, `@jazz-plugin`) the workspace package names use.
 * @param names - workspace package names.
 */
export function workspaceScopes(names: Iterable<string>): Set<string> {
  const scopes = new Set<string>();
  for (const name of names) {
    const match = SCOPED_NAME.exec(name);
    if (match?.[1] !== undefined) {
      scopes.add(match[1]);
    }
  }
  return scopes;
}

/**
 * Resolve one import specifier to the workspace unit it reaches.
 * @param specifier - the import specifier as written.
 * @param workspaceNames - map from workspace package name to unit key.
 * @param importerFile - absolute path of the importing file, for relative specifiers.
 * @param repositoryRoot - absolute repository root, for relative specifiers.
 * @returns the unit key, or undefined for imports outside the workspace.
 */
export function importTargetKey(
  specifier: string,
  workspaceNames: WorkspaceNames,
  importerFile: string,
  repositoryRoot: string,
): string | undefined {
  const scoped = SCOPED_NAME.exec(specifier);
  if (scoped?.[1] !== undefined && scoped[2] !== undefined) {
    const packageName = `${scoped[1]}/${scoped[2]}`;
    const known = workspaceNames.get(packageName);
    if (known !== undefined) {
      return known;
    }
    if (workspaceScopes(workspaceNames.keys()).has(scoped[1])) {
      return packageName;
    }
  }
  const alias = ALIAS_SPECIFIER.exec(specifier);
  if (alias?.[1] !== undefined) {
    return workspaceNames.get(`@jazz/${alias[1]}`) ?? alias[1];
  }
  if (specifier.startsWith(".")) {
    const [area, name] = path
      .relative(repositoryRoot, path.resolve(path.dirname(importerFile), specifier))
      .split(path.sep);
    if (area === "packages") {
      return name;
    }
    if (area === "plugins" && name !== undefined) {
      return `plugins/${name}`;
    }
  }
  return undefined;
}

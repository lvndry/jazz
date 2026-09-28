/**
 * Jazz's own configuration and state, whose changes by the file tools always go to a person.
 *
 * `config.json` holds `autoApprovedCommands` and which MCP servers are trusted, and the rest of
 * `$JAZZ_HOME` holds agents, approvals, tokens, runs and goals. An agent editing them unasked
 * would be granting itself authority, so a write, move or delete there asks for approval under
 * every auto-approve policy and allowlist. Reading them is unaffected; their secret values are
 * redacted like any other file's.
 *
 * The directories under `$JAZZ_HOME` that hold what people and agents author (skills, workflows,
 * personas, memory, the workspace and generated output) follow the ordinary approval policy.
 */

import fs from "node:fs";
import path from "node:path";
import { getGlobalConfigFilePath, getJazzHomeDirectory, getLocalJazzDirectory } from "./paths";

/** Directories directly under `$JAZZ_HOME` that hold authored content. */
const AUTHORED_HOME_DIRECTORIES: readonly string[] = [
  "skills",
  "workflows",
  "personas",
  "memory",
  "workspace",
  "compositions",
  "generated",
  "webapps",
];

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

/** `location` with its existing ancestors' symlinks resolved; the missing tail is kept as written. */
function canonicalLocation(location: string): string {
  let ancestor = path.resolve(location);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(ancestor), ...tail);
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return path.resolve(location);
      }
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function spellings(location: string, fold: (value: string) => string): string[] {
  return [...new Set([path.resolve(location), canonicalLocation(location)].map(fold))];
}

function isWithin(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * How a write, move or delete of `targetPath` would change Jazz's configuration or state, or
 * undefined when it would not. A target containing any of them (`$JAZZ_HOME` itself, a project
 * holding `.jazz/config.json`) counts too. Symlinks are followed and, on macOS and Windows, case
 * is ignored.
 */
export function jazzStateChangeReason(
  targetPath: string,
  options: { readonly platform?: NodeJS.Platform } = {},
): string | undefined {
  const caseInsensitive = CASE_INSENSITIVE_PLATFORMS.has(options.platform ?? process.platform);
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);

  const jazzHomes = spellings(getJazzHomeDirectory(), fold);
  const configFiles = [
    getGlobalConfigFilePath(),
    path.join(getLocalJazzDirectory(), "config.json"),
  ].flatMap((location) => spellings(location, fold));
  const targets = spellings(targetPath, fold);

  for (const target of targets) {
    for (const configFile of configFiles) {
      if (isWithin(configFile, target)) {
        return `${targetPath} is or contains Jazz's config file`;
      }
    }
    for (const home of jazzHomes) {
      if (isWithin(home, target)) {
        return `${targetPath} is or contains Jazz's home directory`;
      }
      if (!isWithin(target, home)) {
        continue;
      }
      const [topLevel] = path.relative(home, target).split(path.sep);
      if (topLevel === undefined || !AUTHORED_HOME_DIRECTORIES.map(fold).includes(topLevel)) {
        return `${targetPath} is Jazz's own state`;
      }
    }
  }
  return undefined;
}

/** The line an approval request adds for a target `jazzStateChangeReason` flags. */
export function jazzStateApprovalNotice(reason: string): string {
  return `${reason}. This changes Jazz's own configuration, so it asks for approval under every auto-approve policy.`;
}

/**
 * Jazz's own credential files, which the model's read tools refuse.
 *
 * `read_file`, `read_pdf`, `pdf_page_count`, `grep`, `find` and `ls` are read-only and run
 * without a prompt, and a model steered by something it read can point them anywhere. Jazz
 * knows exactly where it keeps its own secrets, so those files are refused outright:
 *
 * - `secrets.json`, the no-keyring secret store (`getSecretsFilePath`);
 * - the global config file (`getGlobalConfigFilePath`), which holds `daemon.token` when no
 *   keyring is available;
 * - the lock, temp, and quarantined files written beside them while they change.
 *
 * Each location comes from the same `paths.ts` function the writer uses, so the list cannot
 * drift from where the files really are. Paths are compared as given and after `realpath`, so a
 * symlink to one of them is refused like the file itself, and case-insensitively on macOS and
 * Windows, whose default filesystems are.
 *
 * Credentials other programs keep (`~/.ssh`, cloud CLIs, keyrings) are outside what Jazz can
 * know; keeping them out of reach is the job of the OS user or container the agent runs as.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getChatGptCredentialLockPath,
  getGlobalConfigFilePath,
  getJazzHomeDirectory,
  getSecretsFilePath,
  getSecretsLockPath,
  isSecretsTempFileName,
} from "@/core/utils/paths";

interface SecretLocation {
  /** Absolute path of the file or directory. */
  readonly location: string;
  /** A directory: everything beneath it is covered. */
  readonly directory: boolean;
  /** What it holds, for the refusal message. */
  readonly label: string;
}

/** A prepared set of secret locations; build once per tool call with `loadSecretPathRules`. */
export interface SecretPathRules {
  /** Why `absolutePath` is refused, or undefined when it is readable. Compares lexically. */
  readonly reasonFor: (absolutePath: string) => string | undefined;
}

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

function jazzSecretLocations(): SecretLocation[] {
  return [
    { location: getSecretsFilePath(), directory: false, label: "Jazz secrets" },
    {
      location: getGlobalConfigFilePath(),
      directory: false,
      label: "Jazz config, which can hold the daemon token",
    },
    { location: getSecretsLockPath(), directory: true, label: "the Jazz secrets lock" },
    {
      location: getChatGptCredentialLockPath(),
      directory: true,
      label: "the ChatGPT credential lock",
    },
  ];
}

function realpathOrSelf(location: string): string {
  try {
    return fs.realpathSync.native(location);
  } catch {
    return location;
  }
}

/** The locations as configured and as their symlinks resolve, so either spelling matches. */
function withResolvedSpellings(locations: readonly SecretLocation[]): SecretLocation[] {
  return locations.flatMap((entry) => {
    const resolved = realpathOrSelf(entry.location);
    return resolved === entry.location ? [entry] : [entry, { ...entry, location: resolved }];
  });
}

/**
 * Build the rules for the current `$JAZZ_HOME` and `$JAZZ_CONFIG_PATH`.
 *
 * Reads the environment at call time, so a test or a bot conversation with its own home gets
 * its own list.
 */
export function loadSecretPathRules(
  options: { readonly platform?: NodeJS.Platform } = {},
): SecretPathRules {
  const caseInsensitive = CASE_INSENSITIVE_PLATFORMS.has(options.platform ?? process.platform);
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);

  const locations = withResolvedSpellings(jazzSecretLocations()).map((entry) => ({
    ...entry,
    folded: fold(path.normalize(entry.location)),
  }));
  const jazzHome = getJazzHomeDirectory();
  const tempDirectories = new Set(
    [jazzHome, realpathOrSelf(jazzHome)].map((directory) => fold(path.normalize(directory))),
  );

  return {
    reasonFor: (absolutePath) => {
      const normalized = path.normalize(absolutePath);
      const folded = fold(normalized);
      for (const entry of locations) {
        if (folded === entry.folded) {
          return entry.label;
        }
        if (
          !entry.directory &&
          path.dirname(folded) === path.dirname(entry.folded) &&
          ((path.basename(folded).startsWith(`.${path.basename(entry.folded)}-`) &&
            folded.endsWith(".tmp")) ||
            folded.startsWith(`${entry.folded}.corrupt-`))
        ) {
          return `${entry.label} temporary or quarantined copy`;
        }
        if (entry.directory && folded.startsWith(`${entry.folded}${path.sep}`)) {
          return entry.label;
        }
      }
      if (
        tempDirectories.has(path.dirname(folded)) &&
        isSecretsTempFileName(path.basename(normalized))
      ) {
        return "a Jazz secrets temp file";
      }
      return undefined;
    },
  };
}

/**
 * Why `absolutePath` is refused, checking both the path as given and where its symlinks lead.
 */
export function secretPathReason(
  absolutePath: string,
  rules: SecretPathRules = loadSecretPathRules(),
): string | undefined {
  return rules.reasonFor(absolutePath) ?? rules.reasonFor(realpathOrSelf(absolutePath));
}

/**
 * A predicate over paths a search under `searchRoot` returned, true for the ones to drop.
 *
 * Search backends print paths under the root as they were given, without following symlinks
 * beneath it, so each result is checked as printed and re-based onto the root's real location.
 * One `realpath` per search, none per result.
 */
export function createSecretResultFilter(
  searchRoot: string,
  rules: SecretPathRules = loadSecretPathRules(),
): (candidate: string) => boolean {
  const root = path.normalize(searchRoot);
  const realRoot = realpathOrSelf(root);
  return (candidate) => {
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    if (rules.reasonFor(absolute) !== undefined) {
      return true;
    }
    if (realRoot === root || !absolute.startsWith(root)) {
      return false;
    }
    return rules.reasonFor(path.join(realRoot, absolute.slice(root.length))) !== undefined;
  };
}

/** The error a read tool returns for a refused path. */
export function secretPathRefusal(requestedPath: string, reason: string): string {
  return (
    `Refused to read ${requestedPath}: it holds ${reason}. ` +
    "Credential files stay out of the agent's context; ask the user to run the command " +
    "that needs them."
  );
}

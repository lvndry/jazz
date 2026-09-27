/**
 * Credential path classification for metadata-only reads and approved whole-file transfers.
 * `loadSecretPathRules` combines known credential names, Jazz-owned paths, internal staging
 * trees, and persistent copy destinations. Reuse its result within each tool invocation.
 * `secretPathReason` checks lexical and canonical paths; `createSecretResultFilter` also maps
 * search results through the canonical search root. Discovery returns paths, never values.
 * This is tool-level protection, not isolation from shell commands or external file mutations.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolExecutionResult } from "@/core/types/tools";
import {
  getChatGptCredentialLockPath,
  getGlobalConfigFilePath,
  getJazzHomeDirectory,
  getSecretsFilePath,
  getSecretsLockPath,
  isSecretsTempFileName,
} from "@/core/utils/paths";
import { getProtectedFileRoots, getProtectedFilesRegistryPath } from "@/core/utils/protected-files";

interface SecretLocation {
  /** Absolute path of the file or directory. */
  readonly location: string;
  /** A directory: everything beneath it is covered. */
  readonly directory: boolean;
  /** What it holds, for the metadata result. */
  readonly label: string;
}

/** A prepared set of secret locations; build once per tool call with `loadSecretPathRules`. */
export interface SecretPathRules {
  /** Why `absolutePath` is protected, or undefined when it is readable. Compares lexically. */
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

  let protectedRoots: readonly string[];
  try {
    protectedRoots = getProtectedFileRoots();
  } catch {
    return {
      reasonFor: () =>
        "unavailable protection metadata; repair the protection registry before reading contents",
    };
  }
  const locations = withResolvedSpellings([
    ...jazzSecretLocations(),
    {
      location: getProtectedFilesRegistryPath(),
      directory: false,
      label: "Jazz protection metadata",
    },
    ...protectedRoots.map((location) => ({
      location,
      directory: true,
      label: "a protected file copy",
    })),
  ]).map((entry) => ({
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
      const basename = path.basename(folded);
      if (basename === ".env" || basename.startsWith(".env.") || basename === "secrets.json") {
        return "a credential file";
      }
      if (
        folded
          .split(path.sep)
          .some((part) => part.startsWith(".jazz-stage-") || part.startsWith(".jazz-previous-"))
      ) {
        return "an internal file-transfer staging copy";
      }
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
 * Why `absolutePath` is protected, checking both the path as given and where its symlinks lead.
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

/** Metadata-only result: tools can identify and copy the file without returning its bytes. */
export function protectedFileResult(requestedPath: string, reason: string): ToolExecutionResult {
  return {
    success: true,
    result: {
      path: requestedPath,
      protected: true,
      contentOmitted: true,
      reason,
      message:
        "Contents are protected. Use cp with source and destination to copy the whole file through approval without exposing its values. Use stat for file metadata.",
    },
  };
}

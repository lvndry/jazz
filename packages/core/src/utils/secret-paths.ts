/**
 * Paths the model's read tools refuse, because what they hold is a credential.
 *
 * `read_file`, `read_pdf`, `pdf_page_count`, `grep`, `find` and `ls` are read-only and run
 * without a prompt, and a model steered by something it read can point them anywhere. Paired
 * with any egress tool that is a way to lift a key off the machine. The list here is the one
 * place those tools consult:
 *
 * - Jazz's own secrets under `$JAZZ_HOME`: `secrets.json` (the no-keyring fallback store),
 *   `config.json` (which holds `daemon.token` when no keyring is available), `daemon.token`,
 *   and the lock and temp files written beside them.
 * - Credential stores other programs keep in the home directory: SSH keys, AWS credentials and
 *   SSO caches, GnuPG, `.netrc`, git credentials, Docker and Kubernetes configs, the GitHub CLI
 *   token, gcloud, the pass store, OS keyring files, and `~/.agents/mcp.json` (MCP server env
 *   and headers).
 * - Any process's environment through `/proc/<pid>/environ`.
 *
 * Paths are compared after `realpath`, so a symlink to a secret is refused like the secret, and
 * case-insensitively on macOS and Windows, whose default filesystems are. The shell
 * (`execute_command`) is gated by approval instead and does not consult this list.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getJazzHomeDirectory } from "@/core/utils/paths";

interface SecretLocation {
  /** Absolute path of the file or directory. */
  readonly location: string;
  /** A directory: everything beneath it is covered. */
  readonly directory: boolean;
  /** What it holds, for the refusal message. */
  readonly label: string;
}

interface SecretPattern {
  readonly directory: string;
  readonly basename: RegExp;
  readonly label: string;
}

/** A prepared set of secret locations; build once per tool call with `loadSecretPathRules`. */
export interface SecretPathRules {
  /** Why `absolutePath` is refused, or undefined when it is readable. Compares lexically. */
  readonly reasonFor: (absolutePath: string) => string | undefined;
}

const PROC_ENVIRON_PATTERN = /^\/proc\/[^/]+\/(task\/[^/]+\/)?environ$/;

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

function homeLocations(home: string): SecretLocation[] {
  const inHome = (relative: string, directory: boolean, label: string): SecretLocation => ({
    location: path.join(home, relative),
    directory,
    label,
  });
  return [
    inHome(".ssh", true, "SSH keys"),
    inHome(".aws/credentials", false, "AWS credentials"),
    inHome(".aws/sso/cache", true, "AWS SSO tokens"),
    inHome(".aws/cli/cache", true, "AWS CLI tokens"),
    inHome(".gnupg", true, "GnuPG keys"),
    inHome(".netrc", false, "netrc credentials"),
    inHome(".git-credentials", false, "git credentials"),
    inHome(".docker/config.json", false, "Docker registry credentials"),
    inHome(".kube/config", false, "Kubernetes credentials"),
    inHome(".config/gh/hosts.yml", false, "GitHub CLI token"),
    inHome(".config/gcloud", true, "gcloud credentials"),
    inHome(".password-store", true, "pass password store"),
    inHome(".local/share/keyrings", true, "the OS keyring"),
    inHome("Library/Keychains", true, "the OS keychain"),
    inHome(".agents/mcp.json", false, "MCP server credentials"),
  ];
}

function jazzLocations(jazzHome: string): SecretLocation[] {
  const inJazzHome = (relative: string, directory: boolean, label: string): SecretLocation => ({
    location: path.join(jazzHome, relative),
    directory,
    label,
  });
  return [
    inJazzHome("secrets.json", false, "Jazz secrets"),
    inJazzHome("config.json", false, "Jazz config, which can hold the daemon token"),
    inJazzHome("daemon.token", false, "the Jazz daemon token"),
    inJazzHome(".secrets.lock", true, "the Jazz secrets lock"),
    inJazzHome(".chatgpt-credential.lock", true, "the ChatGPT credential lock"),
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

/** `$HOME` as the process sees it now; `os.homedir()` alone keeps the value from startup. */
function currentHomeDirectory(): string {
  const fromEnvironment = process.env["HOME"]?.trim();
  return fromEnvironment !== undefined && fromEnvironment.length > 0
    ? fromEnvironment
    : os.homedir();
}

/**
 * Build the rules for the current `$JAZZ_HOME` and home directory.
 *
 * Reads `JAZZ_HOME` and the home directory at call time, so a test or a bot conversation with
 * its own home gets its own list.
 */
export function loadSecretPathRules(
  options: {
    readonly home?: string;
    readonly jazzHome?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): SecretPathRules {
  const home = options.home ?? currentHomeDirectory();
  const jazzHome = options.jazzHome ?? getJazzHomeDirectory();
  const caseInsensitive = CASE_INSENSITIVE_PLATFORMS.has(options.platform ?? process.platform);
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);

  const locations = withResolvedSpellings([
    ...(home.length > 0 ? homeLocations(home) : []),
    ...jazzLocations(jazzHome),
  ]).map((entry) => ({ ...entry, folded: fold(path.normalize(entry.location)) }));

  const jazzHomeSpellings = [...new Set([jazzHome, realpathOrSelf(jazzHome)])];
  const patterns: SecretPattern[] = jazzHomeSpellings.map((directory) => ({
    directory: fold(path.normalize(directory)),
    basename: /^\.secrets-.*\.tmp$/i,
    label: "a Jazz secrets temp file",
  }));

  return {
    reasonFor: (absolutePath) => {
      const normalized = path.normalize(absolutePath);
      if (PROC_ENVIRON_PATTERN.test(normalized)) {
        return "a process environment";
      }
      const folded = fold(normalized);
      for (const entry of locations) {
        if (folded === entry.folded) {
          return entry.label;
        }
        if (entry.directory && folded.startsWith(`${entry.folded}${path.sep}`)) {
          return entry.label;
        }
      }
      const parent = path.dirname(folded);
      const name = path.basename(normalized);
      for (const pattern of patterns) {
        if (parent === pattern.directory && pattern.basename.test(name)) {
          return pattern.label;
        }
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

/**
 * GitHub as the default plugin marketplace: install a plugin straight from a source repository, with
 * no author-side build, pack, digest, or release step.
 *
 * `jazz plugin add owner/repo` downloads the repository tarball over HTTPS (no `git` on the user's
 * machine), extracts it, and hashes the source tree; the hash is the digest the operator trusts.
 * A source tree holds only regular files and directories: extraction, copying, and hashing all
 * refuse symlinks and special files, so every byte a plugin can import from its own tree is covered
 * by the digest. Nothing here executes plugin code; install stays separate from trust and enable.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseTar } from "nanotar";
import { fetchWithinOrigins, readStreamWithinLimit } from "./bounded-fetch";

/** A GitHub owner/repo, optionally pinned to a branch, tag, or commit. */
export interface GitHubPluginSource {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: string;
}

/** Bounds on one source-install tarball download. */
export interface TarballLimits {
  /** Largest compressed tarball accepted, checked while streaming. */
  readonly maxDownloadBytes: number;
  /** Largest inflated tar stream, so a small compressed download cannot fill the disk. */
  readonly maxExtractedBytes: number;
  /** Deadline for the whole download, redirects and body included. */
  readonly timeoutMs: number;
  /** The API endpoint answers with one redirect to codeload; a few more tolerate GitHub's own hops. */
  readonly maxRedirects: number;
}

export const DEFAULT_TARBALL_LIMITS: TarballLimits = {
  maxDownloadBytes: 32 * 1024 * 1024,
  maxExtractedBytes: 128 * 1024 * 1024,
  timeoutMs: 60_000,
  maxRedirects: 3,
};

/** Permission bits kept when copying a source file; setuid, setgid, and sticky bits are dropped. */
const FILE_PERMISSION_BITS = 0o777;
const GITHUB_NAME = "[A-Za-z0-9][A-Za-z0-9._-]*";
const HTTPS_URL = new RegExp(
  `^https://github\\.com/(${GITHUB_NAME})/(${GITHUB_NAME}?)(?:\\.git)?(?:/tree/([^/#?]+))?(?:[/#?].*)?$`,
  "i",
);
const SSH_URL = new RegExp(`^git@github\\.com:(${GITHUB_NAME})/(${GITHUB_NAME}?)(?:\\.git)?$`, "i");
const SHORTHAND = new RegExp(`^(${GITHUB_NAME})/(${GITHUB_NAME})(?:@(.+))?$`);

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -".git".length) : repo;
}

function withOptionalRef(owner: string, repo: string, ref: string | undefined): GitHubPluginSource {
  return ref === undefined ? { owner, repo } : { owner, repo, ref };
}

/**
 * Parse a GitHub plugin source, or return undefined when the source is a local path, a non-GitHub
 * URL, or a bare catalog id. Accepts `owner/repo`, `owner/repo@ref`, `github:owner/repo`, an
 * `https://github.com/owner/repo` URL (with an optional `/tree/<ref>`), and a `git@github.com:` URL.
 * Explicit local paths (a leading `.`, `/`, `~`, or a backslash) are never treated as GitHub.
 */
export function parseGitHubPluginSource(raw: string): GitHubPluginSource | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;

  const https = HTTPS_URL.exec(trimmed);
  if (https?.[1] !== undefined && https[2] !== undefined && https[2].length > 0) {
    return withOptionalRef(https[1], stripGitSuffix(https[2]), https[3]);
  }

  const ssh = SSH_URL.exec(trimmed);
  if (ssh?.[1] !== undefined && ssh[2] !== undefined && ssh[2].length > 0) {
    return withOptionalRef(ssh[1], stripGitSuffix(ssh[2]), undefined);
  }

  const scoped = trimmed.startsWith("github:") ? trimmed.slice("github:".length) : trimmed;
  if (/^[.~/\\]/.test(scoped)) return undefined;
  const shorthand = SHORTHAND.exec(scoped);
  if (shorthand?.[1] !== undefined && shorthand[2] !== undefined) {
    return withOptionalRef(shorthand[1], stripGitSuffix(shorthand[2]), shorthand[3]);
  }

  return undefined;
}

/** A human-readable source string recorded for a source-installed plugin. */
export function describeGitHubSource(source: GitHubPluginSource): string {
  const base = `github:${source.owner}/${source.repo}`;
  return source.ref === undefined ? base : `${base}@${source.ref}`;
}

/** GitHub wraps a tarball in a single `owner-repo-<sha>/` directory; drop that first segment. */
function stripTopLevelDirectory(name: string): string | undefined {
  const slash = name.indexOf("/");
  if (slash < 0) return undefined;
  const rest = name.slice(slash + 1);
  return rest.length === 0 ? undefined : rest;
}

/** Resolve a tarball entry under root, rejecting absolute paths and `..` traversal. */
function safeDestination(root: string, relative: string): string | undefined {
  if (path.isAbsolute(relative)) return undefined;
  if (relative.split(/[/\\]/).some((segment) => segment === ".." || segment === ""))
    return undefined;
  const resolved = path.resolve(root, relative);
  const withSeparator = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return resolved === root || resolved.startsWith(withSeparator) ? resolved : undefined;
}

/**
 * Tar entry types that carry metadata for other entries (pax and GNU long-name headers) or only
 * create a directory that file entries create on demand anyway.
 */
const SKIPPED_TAR_ENTRY_TYPES: ReadonlySet<string> = new Set([
  "directory",
  "gnuDirectory",
  "globalExtendedHeader",
  "extendedHeader",
  "gnuLongFileName",
  "gnuLongLinkName",
  "gnuOldLongFileName",
]);

/** The api.github.com tarball endpoint redirects to codeload.github.com, and nowhere else. */
const GITHUB_TARBALL_ORIGINS: ReadonlySet<string> = new Set([
  "https://api.github.com",
  "https://codeload.github.com",
]);

async function gunzipWithinLimit(bytes: Uint8Array, limitBytes: number): Promise<Uint8Array> {
  const inflated = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return readStreamWithinLimit(
    inflated,
    limitBytes,
    `Plugin source tarball expands past ${limitBytes} bytes`,
  );
}

/**
 * Download and extract a GitHub source repository into `destination`. Uses the GitHub tarball
 * endpoint over HTTPS, so no local `git` is required. The download stays on GitHub's origins, has
 * one deadline, and is capped both as downloaded and as inflated. Entries may only be regular files
 * and directories under the repository root: a symlink, hard link, device, or FIFO fails the install.
 */
export async function materializeGitHubSource(
  source: GitHubPluginSource,
  destination: string,
  fetchImpl: typeof fetch = fetch,
  limits: TarballLimits = DEFAULT_TARBALL_LIMITS,
): Promise<void> {
  const ref = source.ref === undefined ? "" : `/${encodeURIComponent(source.ref)}`;
  const url = new URL(`https://api.github.com/repos/${source.owner}/${source.repo}/tarball${ref}`);
  const response = await fetchWithinOrigins(url, {
    allowedOrigins: GITHUB_TARBALL_ORIGINS,
    limitBytes: limits.maxDownloadBytes,
    timeoutMs: limits.timeoutMs,
    maxRedirects: limits.maxRedirects,
    headers: { "user-agent": "jazz-cli", accept: "application/vnd.github+json" },
    fetchImpl,
  });
  if (response.status < 200 || response.status > 299) {
    throw new Error(
      `GitHub returned ${response.status} for ${source.owner}/${source.repo}${
        source.ref === undefined ? "" : `@${source.ref}`
      }`,
    );
  }
  const entries = parseTar(await gunzipWithinLimit(response.bytes, limits.maxExtractedBytes));
  for (const entry of entries) {
    if (entry.type !== undefined && SKIPPED_TAR_ENTRY_TYPES.has(entry.type)) {
      continue;
    }
    const relative = stripTopLevelDirectory(entry.name);
    if (relative === undefined) {
      continue;
    }
    if (entry.type !== "file") {
      throw new Error(
        `Plugin source tarball contains a ${entry.type ?? "unknown"} entry, which source installs refuse: ${entry.name}`,
      );
    }
    const destinationPath = safeDestination(destination, relative);
    if (destinationPath === undefined) {
      throw new Error(`Plugin source tarball contains an unsafe path: ${entry.name}`);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, entry.data ?? new Uint8Array());
  }
}

/** Entry names excluded from both the source-tree hash and every copy of a source tree. */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

interface SourceTreeListing {
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

async function listSourceEntries(
  root: string,
  relative: string,
  directories: string[],
  files: string[],
): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Plugin source contains a symlink, which source installs refuse: ${childRelative}`,
      );
    }
    if (entry.isDirectory()) {
      directories.push(childRelative);
      await listSourceEntries(root, childRelative, directories, files);
    } else if (entry.isFile()) {
      files.push(childRelative);
    } else {
      throw new Error(
        `Plugin source contains a special file, which source installs refuse: ${childRelative}`,
      );
    }
  }
}

/**
 * List a plugin source tree as sorted relative paths, skipping {@link EXCLUDED_DIRECTORIES} by name.
 * Throws on a symlink or any entry that is neither a regular file nor a directory, so the tree that
 * is hashed is exactly the tree that is imported.
 */
export async function listSourceTree(root: string): Promise<SourceTreeListing> {
  const directories: string[] = [];
  const files: string[] = [];
  await listSourceEntries(root, "", directories, files);
  return { directories: directories.sort(), files: files.sort() };
}

/**
 * Deterministic hash of a plugin's source tree, used as the digest the operator trusts. Folds each
 * file's path and content hash in sorted order so the digest is stable across machines and
 * re-downloads. Throws when the tree holds a symlink or a special file (see {@link listSourceTree}).
 */
export async function hashSourceTree(root: string): Promise<string> {
  const { files } = await listSourceTree(root);
  const tree = createHash("sha256");
  for (const relative of files) {
    const content = await fs.readFile(path.join(root, relative));
    const fileHash = createHash("sha256").update(content).digest("hex");
    tree.update(`${relative}\0${fileHash}\n`);
  }
  return tree.digest("hex");
}

/**
 * Copy a plugin source tree into the existing, empty directory `destination`, with the same rules
 * as {@link listSourceTree}. Each file is opened with `O_NOFOLLOW` and checked to be a regular file
 * on the open descriptor, so a file swapped for a symlink after listing is refused, not followed.
 */
export async function copySourceTree(source: string, destination: string): Promise<void> {
  const { directories, files } = await listSourceTree(source);
  for (const relative of directories) {
    await fs.mkdir(path.join(destination, relative), { recursive: true });
  }
  for (const relative of files) {
    const handle = await fs
      .open(path.join(source, relative), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      .catch((error: unknown) => {
        throw new Error(`Plugin source file cannot be read as a regular file: ${relative}`, {
          cause: error,
        });
      });
    try {
      const status = await handle.stat();
      if (!status.isFile()) {
        throw new Error(
          `Plugin source contains a special file, which source installs refuse: ${relative}`,
        );
      }
      await fs.writeFile(path.join(destination, relative), await handle.readFile(), {
        mode: status.mode & FILE_PERMISSION_BITS,
        flag: "wx",
      });
    } finally {
      await handle.close();
    }
  }
}

/** True when `candidate` is a local directory that holds a plugin authoring manifest. */
export async function isLocalSourceDirectory(candidate: string): Promise<boolean> {
  try {
    const resolved = path.resolve(candidate);
    const directory = await fs.stat(resolved);
    if (!directory.isDirectory()) return false;
    const manifest = await fs.stat(path.join(resolved, "jazz-plugin.json"));
    return manifest.isFile();
  } catch {
    return false;
  }
}

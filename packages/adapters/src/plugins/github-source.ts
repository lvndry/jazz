/**
 * GitHub as the default plugin marketplace: install a plugin straight from a source repository, with
 * no author-side build, pack, digest, or release step.
 *
 * `jazz plugin add owner/repo` downloads the repository tarball over HTTPS (no `git` on the user's
 * machine), extracts it, and hashes the source tree; the hash is the digest the operator trusts.
 * Nothing here executes plugin code — install stays separate from trust and enable.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseTarGzip } from "nanotar";

/** A GitHub owner/repo, optionally pinned to a branch, tag, or commit. */
export interface GitHubPluginSource {
  readonly owner: string;
  readonly repo: string;
  readonly ref?: string;
}

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
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
 * Download and extract a GitHub source repository into `destination`. Uses the GitHub tarball
 * endpoint over HTTPS, so no local `git` is required. Path traversal and total size are bounded.
 */
export async function materializeGitHubSource(
  source: GitHubPluginSource,
  destination: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ref = source.ref === undefined ? "" : `/${encodeURIComponent(source.ref)}`;
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball${ref}`;
  const response = await fetchImpl(url, {
    headers: { "user-agent": "jazz-cli", accept: "application/vnd.github+json" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `GitHub returned ${response.status} for ${source.owner}/${source.repo}${
        source.ref === undefined ? "" : `@${source.ref}`
      }`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TARBALL_BYTES) {
    throw new Error("Plugin source tarball exceeds the size limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_TARBALL_BYTES) {
    throw new Error("Plugin source tarball exceeds the size limit");
  }
  const entries = await parseTarGzip(bytes);
  for (const entry of entries) {
    if (entry.type !== "file" || entry.data === undefined) continue;
    const relative = stripTopLevelDirectory(entry.name);
    if (relative === undefined) continue;
    const destinationPath = safeDestination(destination, relative);
    if (destinationPath === undefined) {
      throw new Error(`Plugin source tarball contains an unsafe path: ${entry.name}`);
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, entry.data);
  }
}

/** Directory names excluded from both the source-tree hash and the committed copy. */
export const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

async function collectSourceFiles(root: string, relative: string, into: string[]): Promise<void> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectSourceFiles(root, childRelative, into);
    } else if (entry.isFile()) {
      into.push(childRelative);
    }
  }
}

/**
 * Deterministic hash of a plugin's source tree, used as the digest the operator trusts. Excludes
 * `node_modules`/`.git` and symlinks, and folds each file's path and content hash in sorted order so
 * the digest is stable across machines and re-downloads.
 */
export async function hashSourceTree(root: string): Promise<string> {
  const files: string[] = [];
  await collectSourceFiles(root, "", files);
  files.sort();
  const tree = createHash("sha256");
  for (const relative of files) {
    const content = await fs.readFile(path.join(root, relative));
    const fileHash = createHash("sha256").update(content).digest("hex");
    tree.update(`${relative}\0${fileHash}\n`);
  }
  return tree.digest("hex");
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

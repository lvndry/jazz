/**
 * @fileoverview The write-confinement policy: which directory trees a confined run may write
 * to, and the pure path checks built on it. Everything outside the roots stays readable; only
 * writes are fenced. Reads and the network are never touched.
 *
 * `buildWritePolicy` turns primitives (the session working directory, the home directory, the
 * Jazz scratch directory, the platform) into a `WritePolicy` whose roots are canonical: symlinks
 * resolved the way the kernel resolves them, so a root named through `/tmp` or `/var` is the
 * `/private/...` path the sandbox backends see. `isPathWritable` answers the same question for
 * an in-process file write, so the shell and the file tools confine to one set of roots.
 *
 * `canonicalizePath` resolves a path segment by segment, following each symlink before a `..`
 * pops it, and follows a dangling symlink to where a write through it would create the file.
 * Both are what make `workspace/link-to-etc/passwd` and `workspace/../etc` read as outside.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** Whether write confinement applies to a run's shell commands and file writes. */
export type WriteConfinementMode = "off" | "on";

export interface WritePolicy {
  /** Canonical absolute directories a confined run may write under, deduplicated. */
  readonly roots: readonly string[];
}

/**
 * Home-relative directories that developer tools write to as a matter of course. A policy
 * that fenced only the workspace would fail `bun install`, `npm ci`, `cargo build` and `pip`
 * on their first cache write, which teaches people to turn confinement off. Each entry is a
 * cache or package-manager store, never shell startup files, `~/.ssh`, `~/.config`,
 * `~/Library` outside its caches, or any directory a login shell reads on start.
 *
 * - `.cache`: XDG cache root: pip, uv, node-gyp, huggingface, go build, many CLIs
 * - `.bun`: Bun's install cache and global packages
 * - `.npm`: npm's cacache and logs
 * - `.pnpm-store`: pnpm's content-addressable store
 * - `.yarn`: Yarn's cache and global state
 * - `.cargo/registry`, `.cargo/git`: Cargo's downloaded crates and git checkouts
 */
export const TOOL_CACHE_DIRECTORIES: readonly string[] = [
  ".cache",
  ".bun",
  ".npm",
  ".pnpm-store",
  ".yarn",
  ".cargo/registry",
  ".cargo/git",
];

/** macOS keeps per-user caches under `~/Library/Caches` rather than `~/.cache`. */
export const DARWIN_CACHE_DIRECTORIES: readonly string[] = ["Library/Caches"];

/**
 * Temporary directories, in addition to the process's own `os.tmpdir()`. Scripts and tools
 * name `/tmp` literally, and a world-writable directory gains nothing from being fenced.
 */
export const SYSTEM_TEMP_DIRECTORIES: readonly string[] = ["/tmp", "/var/tmp"];

/** Longest chain of symlinks followed while canonicalizing one path; the kernel's own limit is 40. */
const MAX_SYMLINK_HOPS = 40;

function followDanglingLink(candidate: string, hopsLeft: number): string | undefined {
  if (hopsLeft <= 0) {
    return undefined;
  }
  try {
    if (!lstatSync(candidate).isSymbolicLink()) {
      return undefined;
    }
    return resolveSegments(readlinkSync(candidate), path.dirname(candidate), hopsLeft - 1);
  } catch {
    return undefined;
  }
}

function resolveSegments(input: string, base: string, hopsLeft: number): string {
  const absolute = path.isAbsolute(input) ? input : `${path.resolve(base)}${path.sep}${input}`;
  const segments = absolute.split(path.sep).filter((segment) => segment.length > 0);
  let current = path.parse(absolute).root;
  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      current = path.dirname(current);
      continue;
    }
    const candidate = path.join(current, segment);
    try {
      current = realpathSync(candidate);
    } catch {
      current = followDanglingLink(candidate, hopsLeft) ?? candidate;
    }
  }
  return current;
}

/**
 * The absolute path a write to `input` would land on, with every symlink on the way resolved.
 * Segments that do not exist yet are kept as written, so a file about to be created under an
 * existing directory canonicalizes to its parent's real path plus its own name. `..` is applied
 * after the symlinks before it are followed, never lexically up front, because
 * `link/../x` names the parent of the link's target.
 */
export function canonicalizePath(input: string, base: string = process.cwd()): string {
  return resolveSegments(input, base, MAX_SYMLINK_HOPS);
}

/** Whether `candidate` is `root` or lies beneath it; both must be canonical. */
export function isWithinRoot(candidate: string, root: string): boolean {
  if (candidate === root) {
    return true;
  }
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate.startsWith(prefix);
}

export interface WritePolicyInput {
  /** The session's working directory; a model-supplied `workingDirectory` argument never belongs here. */
  readonly workspace: string;
  readonly homeDir: string;
  /** Jazz's own scratch directory for the agent's working files. */
  readonly jazzScratchDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly tempDirectory: string;
  /** Operator-supplied extra roots, resolved against `workspace`. */
  readonly extraRoots?: readonly string[];
}

/** The roots a policy starts from, canonical and deduplicated, in the order they are listed above. */
export function buildWritePolicy(input: WritePolicyInput): WritePolicy {
  const cacheDirectories =
    input.platform === "darwin"
      ? [...TOOL_CACHE_DIRECTORIES, ...DARWIN_CACHE_DIRECTORIES]
      : TOOL_CACHE_DIRECTORIES;
  const candidates = [
    input.workspace,
    input.jazzScratchDirectory,
    input.tempDirectory,
    ...SYSTEM_TEMP_DIRECTORIES,
    ...cacheDirectories.map((directory) => path.join(input.homeDir, directory)),
    ...(input.extraRoots ?? []),
  ];
  const roots: string[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalizePath(candidate, input.workspace);
    if (!roots.includes(canonical)) {
      roots.push(canonical);
    }
  }
  return { roots };
}

/** Whether a write to `target` (resolved against `base`) lands inside one of the policy's roots. */
export function isPathWritable(policy: WritePolicy, target: string, base: string): boolean {
  const canonical = canonicalizePath(target, base);
  return policy.roots.some((root) => isWithinRoot(canonical, root));
}

/** The first of `targets` a confined write may not touch, as the canonical path; undefined when all may be written. */
export function firstUnwritablePath(
  policy: WritePolicy,
  targets: readonly string[],
  base: string,
): string | undefined {
  for (const target of targets) {
    const canonical = canonicalizePath(target, base);
    if (!policy.roots.some((root) => isWithinRoot(canonical, root))) {
      return canonical;
    }
  }
  return undefined;
}

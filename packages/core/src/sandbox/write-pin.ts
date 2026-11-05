/**
 * @fileoverview Pinning the paths an in-process file mutation will touch, and re-validating them
 * immediately before the mutation.
 *
 * A path-string check followed by a path-string mutation has a window: between the two, a
 * confined shell command can replace a checked directory with a symlink that points outside the
 * writable roots. `pinTargets` resolves each target once (every symlink on the way followed, as
 * the kernel does) and records the identity (device and inode) of the nearest existing ancestor
 * directory. The caller then mutates the pinned real path, never the original string, and calls
 * `recheckPins` as the last step before the mutation: it refuses when the target now resolves
 * anywhere else, when the ancestor is no longer the same directory, or when the pinned path left
 * the roots.
 *
 * Residual window: Node and Bun have no `openat`, no-follow or `renameat` primitives, so the gap
 * between `recheckPins` and the mutating syscall is not closed, only made as short as one
 * synchronous check. Exploiting it takes a process able to swap a directory inside that gap while
 * a tool call runs; the realistic one is a confined shell command racing an in-process tool call
 * in the same batch. The shell itself cannot escape, since the OS confines it.
 *
 * `follow` selects what the mutation acts on: `true` resolves the final path component too (a
 * write that goes through a symlink to its target); `false` keeps the final component as the
 * entry itself (removing or renaming a symlink acts on the link).
 */

import { lstatSync } from "node:fs";
import path from "node:path";
import { canonicalizePath, isWithinRoot, type WritePolicy } from "./write-policy";

export interface PinnedTarget {
  readonly original: string;
  readonly base: string;
  readonly follow: boolean;
  /** The canonical path the mutation must use. */
  readonly realPath: string;
  readonly ancestor: string;
  readonly ancestorDevice: number;
  readonly ancestorInode: number;
}

export type PinResult =
  | { readonly ok: true; readonly pins: readonly PinnedTarget[] }
  | { readonly ok: false; readonly deniedPath: string };

function resolveReal(original: string, base: string, follow: boolean): string {
  if (follow) {
    return canonicalizePath(original, base);
  }
  const trimmed = original.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(path.sep));
  const entry = trimmed.slice(separatorIndex + 1);
  if (entry === "" || entry === "." || entry === "..") {
    return canonicalizePath(original, base);
  }
  const parentInput = separatorIndex < 0 ? "." : trimmed.slice(0, separatorIndex) || path.sep;
  return path.join(canonicalizePath(parentInput, base), entry);
}

function nearestExistingAncestor(
  target: string,
): { path: string; device: number; inode: number } | undefined {
  let current = path.dirname(target);
  for (;;) {
    try {
      const stats = lstatSync(current);
      return { path: current, device: stats.dev, inode: stats.ino };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }
}

function inRoots(policy: WritePolicy, candidate: string): boolean {
  return policy.roots.some((root) => isWithinRoot(candidate, root));
}

export function pinTargets(
  policy: WritePolicy,
  targets: readonly string[],
  base: string,
  follow: boolean,
): PinResult {
  const pins: PinnedTarget[] = [];
  for (const original of targets) {
    const realPath = resolveReal(original, base, follow);
    if (!inRoots(policy, realPath)) {
      return { ok: false, deniedPath: realPath };
    }
    const ancestor = nearestExistingAncestor(realPath);
    if (ancestor === undefined) {
      return { ok: false, deniedPath: realPath };
    }
    pins.push({
      original,
      base,
      follow,
      realPath,
      ancestor: ancestor.path,
      ancestorDevice: ancestor.device,
      ancestorInode: ancestor.inode,
    });
  }
  return { ok: true, pins };
}

/** The path that changed or left the roots since pinning, or undefined when every pin still holds. */
export function recheckPins(
  policy: WritePolicy,
  pins: readonly PinnedTarget[],
): string | undefined {
  for (const pin of pins) {
    const realPath = resolveReal(pin.original, pin.base, pin.follow);
    if (realPath !== pin.realPath || !inRoots(policy, realPath)) {
      return realPath;
    }
    try {
      const stats = lstatSync(pin.ancestor);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        stats.dev !== pin.ancestorDevice ||
        stats.ino !== pin.ancestorInode
      ) {
        return realPath;
      }
    } catch {
      return realPath;
    }
  }
  return undefined;
}

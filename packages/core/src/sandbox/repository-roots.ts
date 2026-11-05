/**
 * @fileoverview The directories a git repository needs written when a confined run works in one
 * of its subdirectories: the repository's top-level directory, and for a linked worktree or a
 * submodule the real git directory (and, for a linked worktree, the common directory it shares
 * with the main checkout). Without them `git add` and `git commit` from a subdirectory fail on
 * the index, refs and objects, which live outside the working directory.
 *
 * Resolution is a read-only walk, never a `git` process: from the starting directory upward, the
 * first `.git` entry decides. A directory means the parent is the top level. A file is a gitfile
 * (`gitdir: <path>`), which names the real git directory; its `commondir` file, when present,
 * names the shared one. Every path is canonicalized like the other roots, so a symlink cannot
 * point a repository root somewhere unwritable-by-design.
 *
 * A repository whose top level is the home directory, or an ancestor of it, is ignored: a
 * dotfiles repository in `~` must not make the whole home writable.
 */

import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { canonicalizePath, isWithinRoot } from "./write-policy";

const GITFILE_PREFIX = "gitdir:";

function readSmallFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function resolveGitfile(gitfile: string, topLevel: string): string[] {
  const text = readSmallFile(gitfile);
  const firstLine = text?.split("\n")[0]?.trim();
  if (firstLine === undefined || !firstLine.startsWith(GITFILE_PREFIX)) {
    return [];
  }
  const gitDirectory = canonicalizePath(firstLine.slice(GITFILE_PREFIX.length).trim(), topLevel);
  const commonText = readSmallFile(path.join(gitDirectory, "commondir"))?.trim();
  return commonText === undefined || commonText.length === 0
    ? [gitDirectory]
    : [gitDirectory, canonicalizePath(commonText, gitDirectory)];
}

/** Canonical roots for the repository containing `start`; empty outside a repository. */
export function findRepositoryRoots(start: string, homeDir: string): string[] {
  const canonicalHome = canonicalizePath(homeDir);
  let current = canonicalizePath(start);
  for (;;) {
    const gitEntry = path.join(current, ".git");
    let kind: "directory" | "file" | undefined;
    try {
      const stats = lstatSync(gitEntry);
      kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : undefined;
    } catch {
      kind = undefined;
    }
    if (kind !== undefined) {
      const parent = path.dirname(current);
      if (current === parent || isWithinRoot(canonicalHome, current)) {
        return [];
      }
      return kind === "directory" ? [current] : [current, ...resolveGitfile(gitEntry, current)];
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return [];
    }
    current = parent;
  }
}

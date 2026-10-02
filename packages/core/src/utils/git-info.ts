/**
 * @fileoverview Minimal git facts for directory occupancy.
 *
 * Two questions only: which branch a directory is on, and which repository it belongs to.
 * The second is what makes worktrees work — every worktree of a repo reports the same
 * `git common dir`, so "same repo, different worktree" is a single comparison.
 *
 * These run with a tight timeout and swallow every failure: occupancy is a courtesy
 * report, and a directory that is not a repo, or git being slow or missing, means
 * "unknown", never an error.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";

const GIT_TIMEOUT_MS = 1000;

export interface GitInfo {
  readonly branch: string;
  /** The resolved `git common dir`: identical across worktrees of one repository. */
  readonly commonDir: string;
}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args, "--", "."],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        // The rejection is swallowed by `readGitInfo`'s catch; the message only matters
        // for a future reader, so no need to stringify an `unknown`.
        if (error !== null)
          reject(error instanceof Error ? error : new Error("git command failed"));
        else resolve(stdout);
      },
    );
  });
}

/**
 * The branch and repo identity of a directory, or `undefined` when it is not inside a
 * repository (or git cannot answer in time).
 */
export async function readGitInfo(directory: string): Promise<GitInfo | undefined> {
  try {
    const [branchRaw, commonRaw] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"], directory),
      git(["rev-parse", "--git-common-dir"], directory),
    ]);
    const branch = branchRaw.trim();
    let commonDir = commonRaw.trim();
    if (!path.isAbsolute(commonDir)) commonDir = path.resolve(directory, commonDir);
    if (branch.length === 0 || commonDir.length === 0) return undefined;
    return { branch, commonDir };
  } catch {
    return undefined;
  }
}

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { readGitInfo } from "./git-info";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("readGitInfo", () => {
  it("returns the branch and the absolute common dir of a repository", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-git-info-"));
    try {
      git(directory, "init", "-q", "-b", "feature/thing");
      git(directory, "config", "user.email", "t@t");
      git(directory, "config", "user.name", "t");
      // A branch only has a name once it holds a commit; before that `rev-parse` reports
      // HEAD, which is exactly the parsing trap this module exists to avoid.
      git(directory, "commit", "-q", "--allow-empty", "-m", "root");
      const info = await readGitInfo(directory);
      expect(info).toBeDefined();
      expect(info?.branch).toBe("feature/thing");
      expect(info?.commonDir).toBe(realpathSync(path.join(directory, ".git")));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns the common dir of the main repository from a worktree, so worktrees compare equal", async () => {
    const main = await mkdtemp(path.join(tmpdir(), "jazz-git-main-"));
    const worktree = path.join(main, "wt");
    try {
      git(main, "init", "-q", "-b", "main");
      git(main, "config", "user.email", "t@t");
      git(main, "config", "user.name", "t");
      git(main, "commit", "-q", "--allow-empty", "-m", "root");
      git(main, "worktree", "add", "-q", "-b", "wt-branch", worktree);

      const fromMain = await readGitInfo(main);
      const fromWorktree = await readGitInfo(worktree);
      const expectedCommonDir = realpathSync(path.join(main, ".git"));
      expect(fromMain?.commonDir).toBe(expectedCommonDir);
      expect(fromWorktree?.commonDir).toBe(expectedCommonDir);
      expect(fromWorktree?.branch).toBe("wt-branch");
    } finally {
      await rm(main, { recursive: true, force: true });
    }
  });

  it("returns undefined for a directory that is not a repository", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "jazz-git-plain-"));
    try {
      expect(await readGitInfo(directory)).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { findRepositoryRoots } from "./repository-roots";
import { buildWritePolicy, isPathWritable } from "./write-policy";

let base: string;
let home: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.homedir(), ".jazz-repo-roots-test-")));
  home = path.join(base, "home");
  mkdirSync(home);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function directory(...segments: string[]): string {
  const target = path.join(base, ...segments);
  mkdirSync(target, { recursive: true });
  return target;
}

function policyFor(cwd: string) {
  return buildWritePolicy({
    workspace: cwd,
    homeDir: home,
    jazzScratchDirectory: path.join(base, "scratch"),
    platform: "linux",
    tempDirectory: path.join(base, "no-temp"),
    extraRoots: findRepositoryRoots(cwd, home),
  });
}

describe("findRepositoryRoots", () => {
  test("a subdirectory of a plain repository resolves to the top level", () => {
    const repository = directory("plain");
    directory("plain", ".git");
    const subdirectory = directory("plain", "packages", "app");
    expect(findRepositoryRoots(subdirectory, home)).toEqual([repository]);
  });

  test("outside any repository there are no roots", () => {
    const loose = directory("loose", "nested");
    expect(findRepositoryRoots(loose, home)).toEqual([]);
  });

  test("a linked worktree adds its gitdir and the common dir", () => {
    const main = directory("main");
    const commonDirectory = directory("main", ".git");
    const gitDirectory = directory("main", ".git", "worktrees", "linked");
    writeFileSync(path.join(gitDirectory, "commondir"), "../..\n");
    const worktree = directory("linked-worktree");
    writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDirectory}\n`);
    const subdirectory = directory("linked-worktree", "src");
    const roots = findRepositoryRoots(subdirectory, home);
    expect(roots).toContain(worktree);
    expect(roots).toContain(gitDirectory);
    expect(roots).toContain(commonDirectory);
    expect(roots).not.toContain(main);
  });

  test("a submodule with a relative gitfile adds its gitdir", () => {
    const superproject = directory("super");
    const moduleGitDirectory = directory("super", ".git", "modules", "lib");
    const submodule = directory("super", "lib");
    writeFileSync(path.join(submodule, ".git"), "gitdir: ../.git/modules/lib\n");
    const roots = findRepositoryRoots(directory("super", "lib", "src"), home);
    expect(roots).toContain(submodule);
    expect(roots).toContain(moduleGitDirectory);
    expect(roots).not.toContain(superproject);
  });

  test("a gitfile that does not name a gitdir adds only the top level", () => {
    const odd = directory("odd");
    writeFileSync(path.join(odd, ".git"), "not a gitfile\n");
    expect(findRepositoryRoots(odd, home)).toEqual([odd]);
  });

  test("a repository at the home directory or above is ignored", () => {
    directory("home", ".git");
    expect(findRepositoryRoots(directory("home", "project"), home)).toEqual([]);
    rmSync(path.join(home, ".git"), { recursive: true });
  });

  test("a symlinked start directory resolves to the real repository", () => {
    const repository = directory("real-repo");
    directory("real-repo", ".git");
    symlinkSync(repository, path.join(base, "repo-link"));
    expect(findRepositoryRoots(path.join(base, "repo-link"), home)).toEqual([repository]);
  });
});

describe("policy with repository roots", () => {
  test("a subdirectory can write the repository's files and its .git", () => {
    const repository = directory("policy-repo");
    directory("policy-repo", ".git");
    const subdirectory = directory("policy-repo", "pkg");
    const policy = policyFor(subdirectory);
    expect(isPathWritable(policy, "../README.md", subdirectory)).toBe(true);
    expect(isPathWritable(policy, path.join(repository, ".git", "index.lock"), subdirectory)).toBe(
      true,
    );
  });

  test("a sibling outside the repository is still refused", () => {
    directory("policy-repo2", ".git");
    const subdirectory = directory("policy-repo2", "pkg");
    const sibling = directory("policy-sibling");
    expect(isPathWritable(policyFor(subdirectory), path.join(sibling, "x"), subdirectory)).toBe(
      false,
    );
  });

  test("a symlink inside the repository that points out of it is still refused", () => {
    directory("policy-repo3", ".git");
    const subdirectory = directory("policy-repo3", "pkg");
    const target = directory("policy-escape-target");
    symlinkSync(target, path.join(base, "policy-repo3", "escape"));
    expect(isPathWritable(policyFor(subdirectory), "../escape/file", subdirectory)).toBe(false);
  });

  test("outside a repository the policy is unchanged", () => {
    const loose = directory("policy-loose", "dir");
    const policy = policyFor(loose);
    expect(isPathWritable(policy, "../sibling-file", loose)).toBe(false);
    expect(isPathWritable(policy, "inside", loose)).toBe(true);
  });

  test("a linked worktree can write its gitdir and the common dir", () => {
    directory("wt-main", ".git", "worktrees", "w");
    writeFileSync(path.join(base, "wt-main", ".git", "worktrees", "w", "commondir"), "../..\n");
    const worktree = directory("wt-linked");
    writeFileSync(
      path.join(worktree, ".git"),
      `gitdir: ${path.join(base, "wt-main", ".git", "worktrees", "w")}\n`,
    );
    const subdirectory = directory("wt-linked", "src");
    const policy = policyFor(subdirectory);
    expect(
      isPathWritable(policy, path.join(base, "wt-main", ".git", "objects", "ab"), subdirectory),
    ).toBe(true);
    expect(isPathWritable(policy, path.join(base, "wt-main", "README.md"), subdirectory)).toBe(
      false,
    );
  });
});

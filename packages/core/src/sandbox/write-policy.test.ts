import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildWritePolicy,
  canonicalizePath,
  firstUnwritablePath,
  isPathWritable,
  isWithinRoot,
  TOOL_CACHE_DIRECTORIES,
} from "./write-policy";

let sandboxBase: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  sandboxBase = realpathSync(mkdtempSync(path.join(process.cwd(), ".write-policy-test-")));
  workspace = path.join(sandboxBase, "workspace");
  outside = path.join(sandboxBase, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
});

afterAll(() => {
  rmSync(sandboxBase, { recursive: true, force: true });
});

function policyFor(extraRoots: readonly string[] = []) {
  return buildWritePolicy({
    workspace,
    homeDir: path.join(sandboxBase, "home"),
    jazzScratchDirectory: path.join(sandboxBase, "jazz-workspace"),
    platform: "linux",
    tempDirectory: path.join(sandboxBase, "tmp"),
    extraRoots,
  });
}

describe("buildWritePolicy", () => {
  test("lists the workspace, scratch, temp and every tool cache directory", () => {
    const policy = policyFor();
    expect(policy.roots).toContain(workspace);
    expect(policy.roots).toContain(path.join(sandboxBase, "jazz-workspace"));
    expect(policy.roots).toContain(path.join(sandboxBase, "tmp"));
    for (const directory of TOOL_CACHE_DIRECTORIES) {
      expect(policy.roots).toContain(path.join(sandboxBase, "home", directory));
    }
  });

  test("adds macOS caches only on darwin", () => {
    const base = {
      workspace,
      homeDir: path.join(sandboxBase, "home"),
      jazzScratchDirectory: path.join(sandboxBase, "jazz-workspace"),
      tempDirectory: path.join(sandboxBase, "tmp"),
    };
    const darwin = buildWritePolicy({ ...base, platform: "darwin" });
    const linux = buildWritePolicy({ ...base, platform: "linux" });
    const libraryCaches = path.join(sandboxBase, "home", "Library", "Caches");
    expect(darwin.roots).toContain(libraryCaches);
    expect(linux.roots).not.toContain(libraryCaches);
  });

  test("never includes the home directory or the Jazz home itself", () => {
    const policy = policyFor();
    expect(policy.roots).not.toContain(path.join(sandboxBase, "home"));
    expect(policy.roots).not.toContain(sandboxBase);
  });

  test("deduplicates roots that canonicalize to the same directory", () => {
    const policy = policyFor([workspace, `${workspace}/.`]);
    expect(policy.roots.filter((root) => root === workspace)).toHaveLength(1);
  });

  test("resolves a symlinked root to its real path", () => {
    const link = path.join(sandboxBase, "workspace-link");
    symlinkSync(workspace, link);
    const policy = buildWritePolicy({
      workspace: link,
      homeDir: path.join(sandboxBase, "home"),
      jazzScratchDirectory: path.join(sandboxBase, "jazz-workspace"),
      platform: "linux",
      tempDirectory: path.join(sandboxBase, "tmp"),
    });
    expect(policy.roots[0]).toBe(workspace);
  });
});

describe("canonicalizePath", () => {
  test("resolves a path through a symlinked directory to its real location", () => {
    const link = path.join(sandboxBase, "dir-link");
    symlinkSync(outside, link);
    expect(canonicalizePath(path.join(link, "new-file"))).toBe(path.join(outside, "new-file"));
  });

  test("applies .. after following a symlink, as the kernel does", () => {
    const link = path.join(workspace, "up-link");
    symlinkSync(outside, link);
    expect(canonicalizePath("up-link/../escaped", workspace)).toBe(
      path.join(sandboxBase, "escaped"),
    );
  });

  test("follows a dangling symlink to where a write would create the file", () => {
    const dangling = path.join(workspace, "dangling");
    symlinkSync(path.join(outside, "not-yet"), dangling);
    expect(canonicalizePath(dangling)).toBe(path.join(outside, "not-yet"));
  });

  test("resolves .. in a dangling link's target after following the symlink before it", () => {
    const deep = path.join(outside, "deep");
    mkdirSync(deep);
    symlinkSync(deep, path.join(workspace, "nested-link"));
    const dangling = path.join(workspace, "nested-dangling");
    symlinkSync("nested-link/../newdir", dangling);
    expect(canonicalizePath(dangling)).toBe(path.join(outside, "newdir"));
    expect(isPathWritable(policyFor(), dangling, workspace)).toBe(false);
  });

  test("terminates on a symlink loop", () => {
    const first = path.join(workspace, "loop-a");
    const second = path.join(workspace, "loop-b");
    symlinkSync(second, first);
    symlinkSync(first, second);
    expect(() => canonicalizePath(first)).not.toThrow();
  });

  test("keeps segments that do not exist yet", () => {
    expect(canonicalizePath("a/b/c.txt", workspace)).toBe(path.join(workspace, "a", "b", "c.txt"));
  });
});

describe("isWithinRoot", () => {
  test("does not treat a sibling sharing a name prefix as inside", () => {
    expect(isWithinRoot("/work/project-evil", "/work/project")).toBe(false);
    expect(isWithinRoot("/work/project/sub", "/work/project")).toBe(true);
    expect(isWithinRoot("/work/project", "/work/project")).toBe(true);
  });
});

describe("isPathWritable", () => {
  test("allows paths under a root and refuses paths beside it", () => {
    const policy = policyFor();
    expect(isPathWritable(policy, "src/index.ts", workspace)).toBe(true);
    expect(isPathWritable(policy, path.join(outside, "x"), workspace)).toBe(false);
  });

  test("refuses .. escapes out of the workspace", () => {
    const policy = policyFor();
    expect(isPathWritable(policy, "../outside/x", workspace)).toBe(false);
    expect(isPathWritable(policy, "sub/../../outside/x", workspace)).toBe(false);
  });

  test("refuses a write through a symlink that points out of the workspace", () => {
    const policy = policyFor();
    const escape = path.join(workspace, "escape-link");
    symlinkSync(outside, escape);
    expect(isPathWritable(policy, "escape-link/passwd", workspace)).toBe(false);
  });

  test("allows a symlink inside the workspace that points to another root", () => {
    const policy = policyFor();
    const toTemp = path.join(workspace, "to-tmp");
    mkdirSync(path.join(sandboxBase, "tmp"), { recursive: true });
    symlinkSync(path.join(sandboxBase, "tmp"), toTemp);
    expect(isPathWritable(policy, "to-tmp/file", workspace)).toBe(true);
  });
});

describe("firstUnwritablePath", () => {
  test("returns the first target outside the roots as a canonical path", () => {
    const policy = policyFor();
    expect(firstUnwritablePath(policy, ["ok.txt", path.join(outside, "bad.txt")], workspace)).toBe(
      path.join(outside, "bad.txt"),
    );
  });

  test("returns undefined when every target is writable", () => {
    expect(firstUnwritablePath(policyFor(), ["a", "b/c"], workspace)).toBeUndefined();
  });
});

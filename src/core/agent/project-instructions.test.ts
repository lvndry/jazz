import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { discoverProjectInstructions, renderProjectInstructions } from "./project-instructions";

// Discovery also reads ~/.agents/AGENTS.md; point "home" at a directory that
// has none so the developer's own file cannot leak into these assertions.
const ISOLATED_HOME = path.join(os.tmpdir(), "jazz-agents-md-no-home");

const createdRoots: string[] = [];

function makeTempTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-agents-md-"));
  createdRoots.push(root);
  // Real path so macOS /var → /private/var symlinking does not break comparisons.
  return fs.realpathSync(root);
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("discoverProjectInstructions", () => {
  test("finds AGENTS.md in the starting directory", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Use bun, not npm.");

    const files = discoverProjectInstructions(root, ISOLATED_HOME);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe(path.join(root, "AGENTS.md"));
    expect(files[0]?.content).toBe("Use bun, not npm.");
  });

  test("returns ancestors first so the nearest file wins", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "packages", "web");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "root rules");
    fs.writeFileSync(path.join(nested, "AGENTS.md"), "web rules");

    const files = discoverProjectInstructions(nested, ISOLATED_HOME);

    expect(files.map((file) => file.content)).toEqual(["root rules", "web rules"]);
  });

  test("stops climbing at the repository root", () => {
    const root = makeTempTree();
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "unrelated outer rules");
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "repo rules");

    const files = discoverProjectInstructions(repo, ISOLATED_HOME);

    expect(files.map((file) => file.content)).toEqual(["repo rules"]);
  });

  test("ignores empty files and missing directories", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "   \n\n");

    expect(discoverProjectInstructions(root, ISOLATED_HOME)).toHaveLength(0);
    expect(
      discoverProjectInstructions(path.join(root, "does-not-exist"), ISOLATED_HOME),
    ).toHaveLength(0);
  });

  test("truncates oversized files with a marker", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "x".repeat(100_000));

    const files = discoverProjectInstructions(root, ISOLATED_HOME);

    expect(files).toHaveLength(1);
    expect(files[0]?.content).toContain("[truncated:");
    expect(files[0]?.content.length).toBeLessThan(40_000);
  });
});

describe("renderProjectInstructions", () => {
  test("renders nothing when no files were found", () => {
    expect(renderProjectInstructions([])).toBe("");
  });

  test("wraps each file with its path and preserves order", () => {
    const rendered = renderProjectInstructions(
      [
        { path: "/repo/AGENTS.md", content: "root rules" },
        { path: "/repo/web/AGENTS.md", content: "web rules" },
      ],
      "/home/someone",
    );

    expect(rendered).toContain('<file path="/repo/AGENTS.md">');
    expect(rendered).toContain('<file path="/repo/web/AGENTS.md">');
    expect(rendered.indexOf("root rules")).toBeLessThan(rendered.indexOf("web rules"));
  });

  test("abbreviates paths under the home directory", () => {
    const rendered = renderProjectInstructions(
      [{ path: "/home/someone/.agents/AGENTS.md", content: "personal defaults" }],
      "/home/someone",
    );

    expect(rendered).toContain('<file path="~/.agents/AGENTS.md">');
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  discoverProjectInstructions,
  GLOBAL_INSTRUCTIONS_BUDGET_BYTES,
  PROJECT_INSTRUCTIONS_BUDGET_BYTES,
  renderProjectInstructions,
} from "./project-instructions";

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

    const { files } = discoverProjectInstructions(root, ISOLATED_HOME);

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

    const { files } = discoverProjectInstructions(nested, ISOLATED_HOME);

    expect(files.map((file) => file.content)).toEqual(["root rules", "web rules"]);
  });

  test("stops climbing at the repository root", () => {
    const root = makeTempTree();
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "unrelated outer rules");
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "repo rules");

    const { files } = discoverProjectInstructions(repo, ISOLATED_HOME);

    expect(files.map((file) => file.content)).toEqual(["repo rules"]);
  });

  test("ignores empty files and missing directories", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "AGENTS.md"), "   \n\n");

    expect(discoverProjectInstructions(root, ISOLATED_HOME).files).toHaveLength(0);
    expect(
      discoverProjectInstructions(path.join(root, "does-not-exist"), ISOLATED_HOME).files,
    ).toHaveLength(0);
  });
});

function makeHome(globalContent?: string): string {
  const home = makeTempTree();
  if (globalContent !== undefined) {
    fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(home, ".agents", "AGENTS.md"), globalContent);
  }
  return home;
}

function makeRepoChain(sizes: readonly number[]): {
  readonly leaf: string;
  readonly paths: readonly string[];
} {
  const root = makeTempTree();
  fs.mkdirSync(path.join(root, ".git"));
  const paths: string[] = [];
  let directory = root;
  sizes.forEach((size, index) => {
    if (index > 0) {
      directory = path.join(directory, `level${String(index)}`);
      fs.mkdirSync(directory);
    }
    fs.writeFileSync(path.join(directory, "AGENTS.md"), "x".repeat(size));
    paths.push(path.join(directory, "AGENTS.md"));
  });
  return { leaf: directory, paths };
}

describe("instruction chain budgets", () => {
  test("a large project chain never evicts the global file", () => {
    const home = makeHome("global defaults");
    const { leaf } = makeRepoChain([PROJECT_INSTRUCTIONS_BUDGET_BYTES * 3, 100]);

    const { files } = discoverProjectInstructions(leaf, home);

    expect(files[0]?.path).toBe(path.join(home, ".agents", "AGENTS.md"));
    expect(files[0]?.content).toBe("global defaults");
    expect(files[0]?.truncatedBytes).toBeUndefined();
  });

  test("global budget is independent of the project chain", () => {
    const home = makeHome("g".repeat(GLOBAL_INSTRUCTIONS_BUDGET_BYTES + 10));
    const { leaf } = makeRepoChain([10]);

    const { files } = discoverProjectInstructions(leaf, home);

    expect(files[0]?.truncatedBytes).toBe(10);
    expect(files[1]?.truncatedBytes).toBeUndefined();
  });

  test("keeps the nearest file and omits the broadest first", () => {
    const quarter = PROJECT_INSTRUCTIONS_BUDGET_BYTES / 4;
    const { leaf, paths } = makeRepoChain([quarter * 2, quarter * 2, quarter * 2]);

    const { files, omissions } = discoverProjectInstructions(leaf, ISOLATED_HOME);

    expect(files.map((file) => file.path)).toEqual([paths[1], paths[2]]);
    expect(omissions).toEqual([{ path: paths[0], bytes: quarter * 2 }]);
  });

  test("truncates the first file that does not fit and keeps its beginning", () => {
    const { leaf, paths } = makeRepoChain([500, PROJECT_INSTRUCTIONS_BUDGET_BYTES - 100]);
    fs.writeFileSync(
      paths[1] as string,
      `HEAD${"y".repeat(PROJECT_INSTRUCTIONS_BUDGET_BYTES - 100 - 4)}`,
    );

    const { files, omissions, reports } = discoverProjectInstructions(leaf, ISOLATED_HOME);

    expect(files).toHaveLength(2);
    expect(files[0]?.path).toBe(paths[0]);
    expect(files[0]?.truncatedBytes).toBe(400);
    expect(files[0]?.content.startsWith("xxx")).toBe(true);
    expect(files[1]?.truncatedBytes).toBeUndefined();
    expect(omissions).toEqual([]);
    expect(reports.map((report) => report.status)).toEqual(["truncated", "included"]);
  });

  test("a single oversized nearest file is cut to the budget and ancestors are omitted", () => {
    const { leaf, paths } = makeRepoChain([100, PROJECT_INSTRUCTIONS_BUDGET_BYTES + 1]);

    const { files, omissions } = discoverProjectInstructions(leaf, ISOLATED_HOME);

    expect(files.map((file) => file.path)).toEqual([paths[1] as string]);
    expect(files[0]?.truncatedBytes).toBe(1);
    expect(omissions.map((omission) => omission.path)).toEqual([paths[0] as string]);
  });

  test("a chain exactly at the budget is included whole", () => {
    const { leaf } = makeRepoChain([PROJECT_INSTRUCTIONS_BUDGET_BYTES - 10, 10]);

    const { files, omissions } = discoverProjectInstructions(leaf, ISOLATED_HOME);

    expect(files).toHaveLength(2);
    expect(files.every((file) => file.truncatedBytes === undefined)).toBe(true);
    expect(omissions).toEqual([]);
  });

  test("one byte over the budget truncates by exactly one byte", () => {
    const { leaf } = makeRepoChain([PROJECT_INSTRUCTIONS_BUDGET_BYTES + 1]);

    const { files } = discoverProjectInstructions(leaf, ISOLATED_HOME);

    expect(files[0]?.truncatedBytes).toBe(1);
    expect(Buffer.byteLength(files[0]?.content ?? "", "utf-8")).toBe(
      PROJECT_INSTRUCTIONS_BUDGET_BYTES,
    );
  });

  test("truncation never splits a multi-byte character", () => {
    const { leaf } = makeRepoChain([1]);
    const content = "é".repeat(PROJECT_INSTRUCTIONS_BUDGET_BYTES);
    fs.writeFileSync(path.join(leaf, "AGENTS.md"), content);

    const { files } = discoverProjectInstructions(leaf, ISOLATED_HOME);

    expect(files[0]?.content).not.toContain("\uFFFD");
    expect(Buffer.byteLength(files[0]?.content ?? "", "utf-8")).toBeLessThanOrEqual(
      PROJECT_INSTRUCTIONS_BUDGET_BYTES,
    );
  });

  test("the result is identical across repeated calls", () => {
    const home = makeHome("global");
    const { leaf } = makeRepoChain([PROJECT_INSTRUCTIONS_BUDGET_BYTES, 5000]);

    expect(discoverProjectInstructions(leaf, home)).toEqual(
      discoverProjectInstructions(leaf, home),
    );
  });
});

describe("instruction file filesystem handling", () => {
  test("skips a symlink resolving outside the tree and reports it", () => {
    const outside = makeTempTree();
    fs.writeFileSync(path.join(outside, "secret.md"), "outside content");
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "AGENTS.md"));

    const { files, reports } = discoverProjectInstructions(root, ISOLATED_HOME);

    expect(files).toHaveLength(0);
    expect(reports.map((report) => report.status)).toEqual(["skipped"]);
  });

  test("follows a symlink that stays inside the tree", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "real.md"), "inside content");
    fs.symlinkSync(path.join(root, "real.md"), path.join(root, "AGENTS.md"));

    const { files } = discoverProjectInstructions(root, ISOLATED_HOME);

    expect(files.map((file) => file.content)).toEqual(["inside content"]);
  });

  test("skips an unreadable file without throwing", () => {
    const root = makeTempTree();
    fs.mkdirSync(path.join(root, ".git"));
    const filePath = path.join(root, "AGENTS.md");
    fs.writeFileSync(filePath, "secret");
    fs.chmodSync(filePath, 0o000);

    try {
      const { files, reports } = discoverProjectInstructions(root, ISOLATED_HOME);
      if (process.getuid?.() !== 0) {
        expect(files).toHaveLength(0);
        expect(reports.map((report) => report.status)).toEqual(["skipped"]);
      }
    } finally {
      fs.chmodSync(filePath, 0o644);
    }
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

  test("renders a truncation marker only for truncated files", () => {
    const rendered = renderProjectInstructions(
      [
        { path: "/repo/AGENTS.md", content: "whole" },
        { path: "/repo/web/AGENTS.md", content: "partial", truncatedBytes: 1234 },
      ],
      "/home/someone",
    );

    expect(rendered.match(/1234 bytes/g)).toHaveLength(1);
    expect(rendered.indexOf("1234")).toBeGreaterThan(rendered.indexOf("partial"));
  });

  test("lists omitted files with their sizes", () => {
    const rendered = renderProjectInstructions(
      [{ path: "/repo/AGENTS.md", content: "kept" }],
      "/home/someone",
      [{ path: "/repo/old/AGENTS.md", bytes: 9876 }],
    );

    expect(rendered).toContain("/repo/old/AGENTS.md");
    expect(rendered).toContain("9876");
  });
});

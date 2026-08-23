import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveFilePickerPath, scanFilePickerEntries } from "./file-picker-files";

/**
 * The scan runs on every pause while typing an `@` mention, in both composers.
 * Its bounds are the only thing keeping that cheap, so they are pinned here
 * rather than left as an implementation detail.
 */
let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jazz-picker-"));

  await fs.writeFile(path.join(root, "alpha.ts"), "");
  await fs.writeFile(path.join(root, "beta.md"), "");
  await fs.writeFile(path.join(root, ".hidden.ts"), "");

  await fs.mkdir(path.join(root, "nested", "one", "two", "three", "four", "five"), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, "nested", "shallow.ts"), "");
  await fs.writeFile(
    path.join(root, "nested", "one", "two", "three", "four", "five", "deep.ts"),
    "",
  );

  for (const ignored of ["node_modules", "dist", "build"]) {
    await fs.mkdir(path.join(root, ignored), { recursive: true });
    await fs.writeFile(path.join(root, ignored, "ignored.ts"), "");
  }

  await fs.mkdir(path.join(root, "many"), { recursive: true });
  for (let index = 0; index < 30; index += 1) {
    await fs.writeFile(path.join(root, "many", `file-${index}.ts`), "");
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function scan(overrides: Partial<Parameters<typeof scanFilePickerEntries>[0]> = {}) {
  return scanFilePickerEntries({
    basePath: root,
    query: "",
    includeDirectories: false,
    ...overrides,
  });
}

describe("scanFilePickerEntries bounds", () => {
  test("stops at maxResults", async () => {
    const entries = await scan({ maxResults: 5 });
    expect(entries).toHaveLength(5);
  });

  test("does not descend past maxDepth", async () => {
    const shallow = await scan({ query: "deep.ts", maxDepth: 2 });
    expect(shallow).toHaveLength(0);

    const deep = await scan({ query: "deep.ts", maxDepth: 8 });
    expect(deep.map((entry) => path.basename(entry.path))).toEqual(["deep.ts"]);
  });

  test("skips dependency and output directories", async () => {
    const entries = await scan({ query: "ignored.ts", maxDepth: 8 });
    expect(entries).toHaveLength(0);
  });

  test("skips dotfiles", async () => {
    const entries = await scan({ query: "hidden" });
    expect(entries).toHaveLength(0);
  });
});

describe("scanFilePickerEntries matching", () => {
  test("matches on a path fragment, not just the filename", async () => {
    const entries = await scan({ query: "nested/shallow", maxDepth: 8 });
    expect(entries.map((entry) => entry.name)).toContain(path.join("nested", "shallow.ts"));
  });

  test("matches case-insensitively", async () => {
    const entries = await scan({ query: "ALPHA" });
    expect(entries.map((entry) => path.basename(entry.path))).toEqual(["alpha.ts"]);
  });

  test("filters by extension when asked", async () => {
    const entries = await scan({ query: "beta", extensions: ["ts"] });
    expect(entries).toHaveLength(0);

    const markdown = await scan({ query: "beta", extensions: ["md"] });
    expect(markdown.map((entry) => path.basename(entry.path))).toEqual(["beta.md"]);
  });

  test("includes directories only when asked", async () => {
    const without = await scan({ query: "nested" });
    expect(without.some((entry) => entry.isDirectory)).toBe(false);

    const with_ = await scan({ query: "nested", includeDirectories: true });
    expect(with_.some((entry) => entry.isDirectory)).toBe(true);
  });

  test("returns names relative to basePath", async () => {
    const entries = await scan({ query: "alpha" });
    expect(entries[0]?.name).toBe("alpha.ts");
    expect(path.isAbsolute(entries[0]?.path ?? "")).toBe(true);
  });

  test("returns nothing for an unreadable base path", async () => {
    const entries = await scanFilePickerEntries({
      basePath: path.join(root, "does-not-exist"),
      query: "",
      includeDirectories: false,
    });
    expect(entries).toEqual([]);
  });
});

describe("resolveFilePickerPath", () => {
  test("resolves a relative path against the base", async () => {
    expect(await resolveFilePickerPath(root, "alpha.ts")).toBe(path.join(root, "alpha.ts"));
  });

  test("accepts an absolute path that exists", async () => {
    const absolute = path.join(root, "beta.md");
    expect(await resolveFilePickerPath(root, absolute)).toBe(absolute);
  });

  test("returns null for a missing path or empty query", async () => {
    expect(await resolveFilePickerPath(root, "nope.ts")).toBeNull();
    expect(await resolveFilePickerPath(root, "")).toBeNull();
  });
});

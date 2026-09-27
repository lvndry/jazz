/**
 * WorkspaceEdit failure tests cover multi-file stale detection and concurrent
 * approved writes, the cases a refactor across collaborating agents must get right.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";
import { applyWorkspaceEdit, prepareWorkspaceEdit } from "../src/workspace-edit";

function replaceFoo(paths: readonly string[]): Record<string, unknown> {
  return {
    changes: Object.fromEntries(
      paths.map((path) => [
        pathToFileURL(path).href,
        [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: "bar",
          },
        ],
      ]),
    ),
  };
}

describe("LSP WorkspaceEdit", () => {
  it("checks every target before writing any file", async () => {
    const root = await mkdtemp(join(tmpdir(), "jazz-lsp-edit-"));
    try {
      const first = join(root, "first.ts");
      const second = join(root, "second.ts");
      await writeFile(first, "foo();\n");
      await writeFile(second, "foo();\n");
      const { prepared, previewDiff } = await prepareWorkspaceEdit(
        replaceFoo([first, second]),
        root,
      );
      expect(previewDiff).toContain(first);
      expect(previewDiff).toContain(second);
      await writeFile(second, "foo(1);\n");
      await expect(applyWorkspaceEdit(prepared)).rejects.toThrow("Stale LSP edit");
      expect(await readFile(first, "utf8")).toBe("foo();\n");
      expect(await readFile(second, "utf8")).toBe("foo(1);\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows one of two concurrent executions of the same approved proposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "jazz-lsp-edit-race-"));
    try {
      const file = join(root, "main.ts");
      await writeFile(file, "foo();\n");
      const { prepared } = await prepareWorkspaceEdit(replaceFoo([file]), root);
      const outcomes = await Promise.allSettled([
        applyWorkspaceEdit(prepared),
        applyWorkspaceEdit(prepared),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      expect(await readFile(file, "utf8")).toBe("bar();\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a language-server response prepared for an older source version", async () => {
    const root = await mkdtemp(join(tmpdir(), "jazz-lsp-edit-source-"));
    try {
      const file = join(root, "main.ts");
      await writeFile(file, "foo(1);\n");
      await expect(
        prepareWorkspaceEdit(replaceFoo([file]), root, { path: file, text: "foo();\n" }),
      ).rejects.toThrow("Stale LSP response");
      expect(await readFile(file, "utf8")).toBe("foo(1);\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

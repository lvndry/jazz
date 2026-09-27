/**
 * Prepare and apply LSP WorkspaceEdits. The proposal contains exact before/after
 * text and SHA-256 snapshots for every target, so approval survives process
 * restart and execution can reject stale files. Unsupported resource operations
 * fail explicitly instead of silently applying a partial refactor.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createPatch } from "diff/lib/patch/create.js";

interface Position {
  readonly line: number;
  readonly character: number;
}
interface TextEdit {
  readonly range: { readonly start: Position; readonly end: Position };
  readonly newText: string;
}
interface PreparedFile {
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly snapshot: string;
}
export interface PreparedWorkspaceEdit {
  readonly files: readonly PreparedFile[];
}

async function lock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.jazz-edit.lock`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await mkdir(lockPath);
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      const info = await stat(lockPath).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 30_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 50));
    }
  }
  throw new Error(`Timed out waiting for edit lock on ${path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(path: string, text: string): string {
  return createHash("sha256").update(path).update("\0").update(text).digest("hex");
}

function offset(text: string, position: Position): number {
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new Error("Invalid LSP edit position");
  let cursor = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf("\n", cursor);
    if (next < 0) throw new Error("LSP edit line is outside the file");
    cursor = next + 1;
  }
  const end = text.indexOf("\n", cursor);
  const lineEnd = end < 0 ? text.length : end;
  const point = cursor + position.character;
  if (point > lineEnd) throw new Error("LSP edit character is outside the line");
  return point;
}

function applyEdits(before: string, edits: readonly TextEdit[]): string {
  const ranges = edits
    .map((edit) => {
      if (
        !isRecord(edit) ||
        !isRecord(edit.range) ||
        !isRecord(edit.range.start) ||
        !isRecord(edit.range.end) ||
        typeof edit.newText !== "string"
      )
        throw new Error("Malformed LSP text edit");
      const start = offset(before, edit.range.start);
      const end = offset(before, edit.range.end);
      if (end < start) throw new Error("Reversed LSP text edit");
      return { start, end, replacement: edit.newText };
    })
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let result = before;
  let earliest = before.length + 1;
  for (const edit of ranges) {
    if (edit.end > earliest) throw new Error("Overlapping LSP text edits");
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
    earliest = edit.start;
  }
  return result;
}

/** Normalize both WorkspaceEdit representations into canonical, workspace-contained files. */
export async function prepareWorkspaceEdit(
  value: unknown,
  root: string,
  source?: { readonly path: string; readonly text: string },
): Promise<{ prepared: PreparedWorkspaceEdit; previewDiff: string }> {
  if (!isRecord(value)) throw new Error("Language server returned no WorkspaceEdit");
  if (source && (await readFile(source.path, "utf8")) !== source.text)
    throw new Error(
      `Stale LSP response: ${source.path} changed while the language server prepared its edit. Retry the request.`,
    );
  const edits = new Map<string, TextEdit[]>();
  const append = (uri: unknown, items: unknown) => {
    if (typeof uri !== "string" || !uri.startsWith("file:") || !Array.isArray(items))
      throw new Error("Language server returned a malformed WorkspaceEdit");
    const list = edits.get(uri) ?? [];
    list.push(...(items as TextEdit[]));
    edits.set(uri, list);
  };
  if (isRecord(value["changes"])) {
    for (const [uri, items] of Object.entries(value["changes"])) append(uri, items);
  }
  if (Array.isArray(value["documentChanges"])) {
    for (const change of value["documentChanges"]) {
      if (!isRecord(change) || !isRecord(change["textDocument"]))
        throw new Error("LSP resource operations require explicit support; no files were changed");
      append(change["textDocument"]["uri"], change["edits"]);
    }
  }
  if (edits.size === 0) throw new Error("Language server proposed no text changes");
  const canonicalRoot = await realpath(root);
  const files: PreparedFile[] = [];
  for (const [uri, items] of edits) {
    const path = await realpath(fileURLToPath(uri));
    const rel = relative(canonicalRoot, path);
    if (rel.startsWith("..") || rel.startsWith("/") || rel === "")
      throw new Error(`LSP edit targets a file outside workspace: ${path}`);
    const before = await readFile(path, "utf8");
    if (source && path === source.path && before !== source.text)
      throw new Error(
        `Stale LSP response: ${path} changed while the language server prepared its edit. Retry the request.`,
      );
    const after = applyEdits(before, items);
    if (after !== before) files.push({ path, before, after, snapshot: hash(path, before) });
  }
  if (files.length === 0) throw new Error("Language server proposed no effective text changes");
  files.sort((a, b) => a.path.localeCompare(b.path));
  const previewDiff = files
    .map(({ path, before, after }) => createPatch(path, before, after))
    .join("\n");
  return { prepared: { files }, previewDiff };
}

/** Revalidate every file, then stage and replace files. A changed snapshot aborts all writes. */
export async function applyWorkspaceEdit(value: unknown): Promise<string> {
  if (!isRecord(value) || !Array.isArray(value["files"]) || value["files"].length === 0)
    throw new Error("Invalid prepared LSP edit");
  const files = value["files"] as PreparedFile[];
  const releases: Array<() => Promise<void>> = [];
  const staged: { path: string; temp: string }[] = [];
  try {
    for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path)))
      releases.push(await lock(file.path));
    for (const file of files) {
      if (
        !file ||
        typeof file.path !== "string" ||
        typeof file.before !== "string" ||
        typeof file.after !== "string" ||
        typeof file.snapshot !== "string"
      )
        throw new Error("Invalid prepared LSP edit file");
      const path = await realpath(file.path);
      const current = await readFile(path, "utf8");
      if (path !== file.path || hash(path, current) !== file.snapshot || current !== file.before)
        throw new Error(
          `Stale LSP edit: ${file.path} changed after approval. Re-run the LSP tool and review its new diff.`,
        );
    }
    for (const file of files) {
      const temp = join(dirname(file.path), `.jazz-lsp-${process.pid}-${randomUUID()}.tmp`);
      const mode = (await stat(file.path)).mode;
      await writeFile(temp, file.after, { flag: "wx", mode });
      staged.push({ path: file.path, temp });
    }
    for (const { path, temp } of staged) await rename(temp, path);
  } finally {
    await Promise.all(staged.map(({ temp }) => unlink(temp).catch(() => undefined)));
    for (const release of releases.reverse()) await release();
  }
  return `Applied LSP edit to ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((file) => file.path).join(", ")}`;
}

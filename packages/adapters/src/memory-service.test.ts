import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { MAX_MEMORY_FILE_BYTES, MAX_MEMORY_FILES_PER_AGENT } from "@jazz/core/constants/memory";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { MemoryServiceImpl } from "./memory-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function runEither<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return runEffect(eff.pipe(Effect.either));
}

function makeService(): MemoryServiceImpl {
  return new MemoryServiceImpl({ baseMemoryDirectory: tmpDir });
}

describe("view", () => {
  test("returns an empty directory listing for a fresh agent", async () => {
    const service = makeService();
    const outcome = await runEffect(service.view("agent-1", ""));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries).toEqual([]);
    }
  });

  test("lists a file after create", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "hello"));
    const outcome = await runEffect(service.view("agent-1", ""));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries.map((e) => e.name)).toEqual(["notes.txt"]);
    }
  });

  test("reads file content with line numbers via view_range", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "line1\nline2\nline3"));
    const outcome = await runEffect(service.view("agent-1", "notes.txt", [2, 3]));
    expect(outcome.kind).toBe("file");
    if (outcome.kind === "file") {
      expect(outcome.content).toBe("line2\nline3");
      expect(outcome.startLine).toBe(2);
      expect(outcome.totalLines).toBe(3);
    }
  });

  test("returns not_found for a missing path", async () => {
    const service = makeService();
    const outcome = await runEffect(service.view("agent-1", "missing.txt"));
    expect(outcome.kind).toBe("not_found");
  });
});

describe("create", () => {
  test("creates a file and its parent directories", async () => {
    const service = makeService();
    const outcome = await runEffect(service.create("agent-1", "people/alex.md", "likes coffee"));
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view("agent-1", "people/alex.md"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.content).toBe("likes coffee");
    }
  });

  test("treats leading slash as memory-relative and reports the backing path", async () => {
    const service = makeService();
    const outcome = await runEffect(service.create("agent-1", "/people/alex.md", "likes coffee"));
    const expectedPath = path.join(
      fs.realpathSync(path.join(tmpDir, "agent-1")),
      "people",
      "alex.md",
    );
    expect(outcome.success).toBe(true);
    expect(outcome.message).toContain(expectedPath);

    const view = await runEffect(service.view("agent-1", "/people/alex.md"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.path).toBe(expectedPath);
      expect(view.content).toBe("likes coffee");
    }
  });

  test("errors instead of overwriting an existing file", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "first"));
    const outcome = await runEffect(service.create("agent-1", "notes.txt", "second"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("already exists");
    const view = await runEffect(service.view("agent-1", "notes.txt"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.content).toBe("first");
    }
  });

  test("rejects a file exceeding the per-file byte cap", async () => {
    const service = makeService();
    const tooBig = "x".repeat(MAX_MEMORY_FILE_BYTES + 1);
    const result = await runEither(service.create("agent-1", "big.txt", tooBig));
    expect(result._tag).toBe("Left");
  });

  test("rejects once the per-agent file count cap is exceeded", async () => {
    const service = makeService();
    for (let i = 0; i < MAX_MEMORY_FILES_PER_AGENT; i++) {
      await runEffect(service.create("agent-1", `file-${i}.txt`, "x"));
    }
    const result = await runEither(service.create("agent-1", "one-too-many.txt", "x"));
    expect(result._tag).toBe("Left");
  }, 30_000);
});

describe("str_replace", () => {
  test("replaces a unique match", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "hello world"));
    const outcome = await runEffect(service.strReplace("agent-1", "notes.txt", "world", "there"));
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view("agent-1", "notes.txt"));
    if (view.kind === "file") expect(view.content).toBe("hello there");
  });

  test("deletes in place when new_str is omitted", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "hello world"));
    await runEffect(service.strReplace("agent-1", "notes.txt", " world", undefined));
    const view = await runEffect(service.view("agent-1", "notes.txt"));
    if (view.kind === "file") expect(view.content).toBe("hello");
  });

  test("fails with no match", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "hello world"));
    const outcome = await runEffect(service.strReplace("agent-1", "notes.txt", "goodbye", "hi"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("did not appear verbatim");
  });

  test("fails with multiple matches and reports line numbers", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "dup\nother\ndup"));
    const outcome = await runEffect(service.strReplace("agent-1", "notes.txt", "dup", "x"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("lines: 1, 3");
  });
});

describe("insert", () => {
  test("inserts text at the given line", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "a\nb"));
    await runEffect(service.insert("agent-1", "notes.txt", 1, "inserted"));
    const view = await runEffect(service.view("agent-1", "notes.txt"));
    if (view.kind === "file") expect(view.content).toBe("a\ninserted\nb");
  });

  test("rejects an out-of-range insert_line", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "a\nb"));
    const outcome = await runEffect(service.insert("agent-1", "notes.txt", 99, "x"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("Invalid `insert_line`");
  });
});

describe("delete", () => {
  test("deletes an existing file", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "x"));
    const outcome = await runEffect(service.delete("agent-1", "notes.txt"));
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view("agent-1", "notes.txt"));
    expect(view.kind).toBe("not_found");
  });

  test("fails for a missing path", async () => {
    const service = makeService();
    const outcome = await runEffect(service.delete("agent-1", "missing.txt"));
    expect(outcome.success).toBe(false);
  });

  test("refuses to delete the memory root", async () => {
    const service = makeService();
    const outcome = await runEffect(service.delete("agent-1", ""));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("cannot delete");
  });
});

describe("rename", () => {
  test("renames an existing file", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "old.txt", "x"));
    const outcome = await runEffect(service.rename("agent-1", "old.txt", "new.txt"));
    expect(outcome.success).toBe(true);
    expect((await runEffect(service.view("agent-1", "old.txt"))).kind).toBe("not_found");
    expect((await runEffect(service.view("agent-1", "new.txt"))).kind).toBe("file");
  });

  test("fails when the destination already exists", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "a.txt", "a"));
    await runEffect(service.create("agent-1", "b.txt", "b"));
    const outcome = await runEffect(service.rename("agent-1", "a.txt", "b.txt"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("already exists");
  });
});

describe("path safety", () => {
  test("rejects .. traversal", async () => {
    const service = makeService();
    const result = await runEither(service.create("agent-1", "../escape.txt", "x"));
    expect(result._tag).toBe("Left");
  });

  test("rejects a null byte", async () => {
    const service = makeService();
    const result = await runEither(service.create("agent-1", "notes\0.txt", "x"));
    expect(result._tag).toBe("Left");
  });

  test("rejects paths deeper than the max depth", async () => {
    const service = makeService();
    const result = await runEither(service.create("agent-1", "a/b/c/d/e.txt", "x"));
    expect(result._tag).toBe("Left");
  });

  test("rejects a path segment longer than the max length", async () => {
    const service = makeService();
    const result = await runEither(service.create("agent-1", `${"x".repeat(200)}.txt`, "x"));
    expect(result._tag).toBe("Left");
  });

  test("rejects an invalid agent id", async () => {
    const service = makeService();
    const result = await runEither(service.view("../not-an-agent", "notes.txt"));
    expect(result._tag).toBe("Left");
  });

  test("rejects reading through a symlink that escapes the memory root", async () => {
    const service = makeService();
    const agentRoot = path.join(tmpDir, "agent-1");
    fs.mkdirSync(agentRoot, { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");
    fs.symlinkSync(outsideDir, path.join(agentRoot, "link"));

    try {
      const result = await runEither(service.view("agent-1", "link/secret.txt"));
      expect(result._tag).toBe("Left");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

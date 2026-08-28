import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_FILES_PER_AGENT,
} from "@jazz/core/constants/workspace";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { WorkspaceServiceImpl } from "./workspace-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-workspace-test-"));
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

function makeService(maxTotalBytesPerAgent?: number): WorkspaceServiceImpl {
  return new WorkspaceServiceImpl({
    baseWorkspaceDirectory: tmpDir,
    ...(maxTotalBytesPerAgent !== undefined ? { maxTotalBytesPerAgent } : {}),
  });
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
    const outcome = await runEffect(
      service.create("agent-1", "research/topic.md", "full findings"),
    );
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view("agent-1", "research/topic.md"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.content).toBe("full findings");
    }
  });

  test("errors instead of overwriting an existing file", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "first"));
    const outcome = await runEffect(service.create("agent-1", "notes.txt", "second"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("already exists");
  });

  test("rejects a file exceeding the per-file byte cap", async () => {
    const service = makeService();
    const tooBig = "x".repeat(MAX_WORKSPACE_FILE_BYTES + 1);
    const result = await runEither(service.create("agent-1", "big.txt", tooBig));
    expect(result._tag).toBe("Left");
  });

  test("rejects once the configured per-agent total-byte cap is exceeded", async () => {
    // A small, explicit cap so this stays fast — the point is that the cap is
    // configurable per instance, unlike memory's fixed constant.
    const service = makeService(100);
    await runEffect(service.create("agent-1", "a.txt", "x".repeat(60)));
    const result = await runEither(service.create("agent-1", "b.txt", "x".repeat(60)));
    expect(result._tag).toBe("Left");
  });

  test("defaults the total-byte cap to DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT when unset", async () => {
    const service = makeService();
    const outcome = await runEffect(service.create("agent-1", "notes.txt", "small file"));
    expect(outcome.success).toBe(true);
  });

  test("rejects once the per-agent file count cap is exceeded", async () => {
    const service = makeService();
    // Seed directly on disk rather than through `create`, which locks and
    // walks the whole tree on every call — doing that MAX_WORKSPACE_FILES_PER_AGENT
    // times is O(n^2) and times out well before reaching the cap.
    const agentRoot = path.join(tmpDir, "agent-1");
    fs.mkdirSync(agentRoot, { recursive: true });
    for (let i = 0; i < MAX_WORKSPACE_FILES_PER_AGENT; i++) {
      fs.writeFileSync(path.join(agentRoot, `file-${i}.txt`), "x");
    }
    const result = await runEither(service.create("agent-1", "one-too-many.txt", "x"));
    expect(result._tag).toBe("Left");
  }, 15_000);
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

  test("fails with no match", async () => {
    const service = makeService();
    await runEffect(service.create("agent-1", "notes.txt", "hello world"));
    const outcome = await runEffect(service.strReplace("agent-1", "notes.txt", "goodbye", "hi"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("did not appear verbatim");
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

  test("refuses to delete the workspace root", async () => {
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
    const result = await runEither(service.create("agent-1", "a/b/c/d/e/f/g.txt", "x"));
    expect(result._tag).toBe("Left");
  });

  test("rejects an invalid agent id", async () => {
    const service = makeService();
    const result = await runEither(service.view("../not-an-agent", "notes.txt"));
    expect(result._tag).toBe("Left");
  });

  test("rejects reading through a symlink that escapes the workspace root", async () => {
    const service = makeService();
    const agentRoot = path.join(tmpDir, "agent-1");
    fs.mkdirSync(agentRoot, { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-workspace-outside-"));
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

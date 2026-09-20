import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { MAX_MEMORY_FILE_BYTES, MAX_MEMORY_FILES_PER_SCOPE } from "@jazz/core/constants/memory";
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

const scopes = ["agent-1"];

const writeContext = { agentId: "agent-1" } as const;

describe("view", () => {
  test("lists the accessible scopes at the root path", async () => {
    const service = makeService();
    const outcome = await runEffect(service.view(scopes, ""));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries).toEqual([{ name: "agent-1/", kind: "directory", sizeBytes: 0 }]);
    }
  });

  test("returns an empty directory listing for a fresh scope", async () => {
    const service = makeService();
    const outcome = await runEffect(service.view(scopes, "agent-1"));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries).toEqual([]);
    }
  });

  test("lists a file after create", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "hello", writeContext));
    const outcome = await runEffect(service.view(scopes, "agent-1"));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries.map((e) => e.name)).toEqual(["notes.txt"]);
    }
  });

  test("reads file content with line numbers via view_range", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/notes.txt", "line1\nline2\nline3", writeContext),
    );
    const outcome = await runEffect(service.view(scopes, "agent-1/notes.txt", [2, 3]));
    expect(outcome.kind).toBe("file");
    if (outcome.kind === "file") {
      expect(outcome.content).toBe("line2\nline3");
      expect(outcome.startLine).toBe(2);
      expect(outcome.totalLines).toBe(3);
    }
  });

  test("returns not_found for a missing path", async () => {
    const service = makeService();
    const outcome = await runEffect(service.view(scopes, "agent-1/missing.txt"));
    expect(outcome.kind).toBe("not_found");
  });

  test("returns not_found for a scope outside the accessible set", async () => {
    const service = makeService();
    const outcome = await runEffect(service.view(scopes, "other-scope/notes.txt"));
    expect(outcome.kind).toBe("not_found");
  });
});

describe("create", () => {
  test("creates a file and its parent directories", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.create(scopes, "agent-1/people/alex.md", "likes coffee", writeContext),
    );
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view(scopes, "agent-1/people/alex.md"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.content).toBe("likes coffee");
    }
  });

  test("treats a leading slash as relative to the scope root and reports the backing path", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.create(scopes, "/agent-1/people/alex.md", "likes coffee", writeContext),
    );
    const expectedPath = path.join(
      fs.realpathSync(path.join(tmpDir, "agent-1")),
      "people",
      "alex.md",
    );
    expect(outcome.success).toBe(true);
    expect(outcome.message).toContain(expectedPath);

    const view = await runEffect(service.view(scopes, "/agent-1/people/alex.md"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.path).toBe(expectedPath);
      expect(view.content).toBe("likes coffee");
    }
  });

  test("errors instead of overwriting an existing file", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "first", writeContext));
    const outcome = await runEffect(
      service.create(scopes, "agent-1/notes.txt", "second", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("already exists");
    const view = await runEffect(service.view(scopes, "agent-1/notes.txt"));
    expect(view.kind).toBe("file");
    if (view.kind === "file") {
      expect(view.content).toBe("first");
    }
  });

  test("rejects a file exceeding the per-file byte cap", async () => {
    const service = makeService();
    const tooBig = "x".repeat(MAX_MEMORY_FILE_BYTES + 1);
    const result = await runEither(service.create(scopes, "agent-1/big.txt", tooBig, writeContext));
    expect(result._tag).toBe("Left");
  });

  test("rejects once the per-scope file count cap is exceeded", async () => {
    const service = makeService();
    for (let i = 0; i < MAX_MEMORY_FILES_PER_SCOPE; i++) {
      await runEffect(service.create(scopes, `agent-1/file-${i}.txt`, "x", writeContext));
    }
    const result = await runEither(
      service.create(scopes, "agent-1/one-too-many.txt", "x", writeContext),
    );
    expect(result._tag).toBe("Left");
  }, 30_000);

  test("fails when the path names no scope", async () => {
    const service = makeService();
    const outcome = await runEffect(service.create(scopes, "notes.txt", "x", writeContext));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("Accessible scopes");
  });

  test("fails when the path names a scope outside the accessible set", async () => {
    const service = makeService();
    const outcome = await runEffect(
      service.create(scopes, "other-scope/notes.txt", "x", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("Unknown memory scope");
  });
});

describe("sidecar resilience", () => {
  function sidecarPath() {
    return path.join(tmpDir, "agent-1", ".provenance.json");
  }

  test("a corrupt sidecar does not take down a read", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/facts/a.md", "x", writeContext));
    fs.writeFileSync(sidecarPath(), "{not json");
    const index = await runEffect(service.index(scopes));
    expect(index).toEqual([]);
  });

  test("a corrupt sidecar is quarantined rather than overwritten by the next write", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/facts/a.md", "x", writeContext));
    fs.writeFileSync(sidecarPath(), "{not json");

    await runEffect(service.create(scopes, "agent-1/facts/b.md", "y", writeContext));

    const quarantined = fs
      .readdirSync(path.join(tmpDir, "agent-1"))
      .filter((name) => name.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, "agent-1", quarantined[0] as string), "utf8")).toBe(
      "{not json",
    );
  });

  test("a record with a malformed field does not throw on the next write", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/facts/a.md", "x", writeContext));
    fs.writeFileSync(
      sidecarPath(),
      JSON.stringify({ files: { "facts/a.md": { writtenBy: "not-an-array", summary: 42 } } }),
    );

    const outcome = await runEffect(
      service.strReplace(scopes, "agent-1/facts/a.md", "x", "z", writeContext),
    );
    expect(outcome.success).toBe(true);
  });

  test("a malformed summary never reaches the index as a non-string", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/preferences/_global/a.md", "x", writeContext));
    fs.writeFileSync(
      sidecarPath(),
      JSON.stringify({ files: { "preferences/_global/a.md": { summary: { nested: true } } } }),
    );
    const index = await runEffect(service.index(scopes));
    expect(index[0]?.summary).toBeUndefined();
  });
});

describe("provenance follows the tree", () => {
  test("deleting a directory forgets the records beneath it", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/preferences/moodboard/a.md", "scale it", writeContext),
    );
    expect(await runEffect(service.index(scopes))).toHaveLength(1);

    await runEffect(service.delete(scopes, "agent-1/preferences/moodboard"));

    expect(await runEffect(service.index(scopes))).toEqual([]);
  });

  test("renaming a directory re-keys the records beneath it", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/preferences/moodboard/a.md", "scale it", writeContext),
    );
    await runEffect(
      service.rename(
        scopes,
        "agent-1/preferences/moodboard",
        "agent-1/preferences/slides",
        writeContext,
      ),
    );

    const index = await runEffect(service.index(scopes));
    expect(index.map((entry) => [entry.path, entry.workflow])).toEqual([
      ["agent-1/preferences/slides/a.md", "slides"],
    ]);
  });
});

describe("single entry per subject", () => {
  const preferenceEntry = (subject: string) => ({ agentId: "agent-1", entry: { subject } });

  test("refuses a second preference on a subject already recorded", async () => {
    const service = makeService();
    await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/_global/auto-open.md",
        "auto-open renders",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    const outcome = await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/_global/open-the-render.md",
        "open renders when done",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("already recorded");
    expect(outcome.message).toContain("auto-open.md");
  });

  test("returns the existing content so the caller can amend it", async () => {
    const service = makeService();
    await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/_global/auto-open.md",
        "auto-open renders when a task finishes",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    const outcome = await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/_global/other.md",
        "x",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    expect(outcome.message).toContain("auto-open renders when a task finishes");
    expect(outcome.message).toContain("str_replace");
  });

  test("collides across workflows, since the subject is what is unique", async () => {
    const service = makeService();
    await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/_global/auto-open.md",
        "auto-open renders",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    const outcome = await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/moodboard/auto-open.md",
        "auto-open moodboards",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    expect(outcome.success).toBe(false);
  });

  test("allows the same subject under a different kind", async () => {
    const service = makeService();
    await runEffect(
      service.create(
        scopes,
        "agent-1/preferences/_global/auto-open.md",
        "auto-open renders",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    const outcome = await runEffect(
      service.create(
        scopes,
        "agent-1/facts/auto-open.md",
        "renders are produced by the moodboard tool",
        preferenceEntry("rendered-output-opening"),
      ),
    );
    expect(outcome.success).toBe(true);
  });

  test("allows two lessons on one subject, which may guard different situations", async () => {
    const service = makeService();
    await runEffect(
      service.create(
        scopes,
        "agent-1/lessons/moodboard/scaling.md",
        "scale artboards",
        preferenceEntry("artboard-scaling"),
      ),
    );
    const outcome = await runEffect(
      service.create(
        scopes,
        "agent-1/lessons/slides/scaling.md",
        "scale slides differently",
        preferenceEntry("artboard-scaling"),
      ),
    );
    expect(outcome.success).toBe(true);
  });

  test("does not constrain untyped legacy entries", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.md", "a", preferenceEntry("thing")));
    const outcome = await runEffect(
      service.create(scopes, "agent-1/other.md", "b", preferenceEntry("thing")),
    );
    expect(outcome.success).toBe(true);
  });
});

describe("str_replace", () => {
  test("replaces a unique match", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "hello world", writeContext));
    const outcome = await runEffect(
      service.strReplace(scopes, "agent-1/notes.txt", "world", "there", writeContext),
    );
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view(scopes, "agent-1/notes.txt"));
    if (view.kind === "file") expect(view.content).toBe("hello there");
  });

  test("deletes in place when new_str is omitted", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "hello world", writeContext));
    await runEffect(
      service.strReplace(scopes, "agent-1/notes.txt", " world", undefined, writeContext),
    );
    const view = await runEffect(service.view(scopes, "agent-1/notes.txt"));
    if (view.kind === "file") expect(view.content).toBe("hello");
  });

  test("fails with no match", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "hello world", writeContext));
    const outcome = await runEffect(
      service.strReplace(scopes, "agent-1/notes.txt", "goodbye", "hi", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("did not appear verbatim");
  });

  test("fails with multiple matches and reports line numbers", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "dup\nother\ndup", writeContext));
    const outcome = await runEffect(
      service.strReplace(scopes, "agent-1/notes.txt", "dup", "x", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("lines: 1, 3");
  });
});

describe("insert", () => {
  test("inserts text at the given line", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "a\nb", writeContext));
    await runEffect(service.insert(scopes, "agent-1/notes.txt", 1, "inserted", writeContext));
    const view = await runEffect(service.view(scopes, "agent-1/notes.txt"));
    if (view.kind === "file") expect(view.content).toBe("a\ninserted\nb");
  });

  test("rejects an out-of-range insert_line", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "a\nb", writeContext));
    const outcome = await runEffect(
      service.insert(scopes, "agent-1/notes.txt", 99, "x", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("Invalid `insert_line`");
  });
});

describe("delete", () => {
  test("deletes an existing file", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.txt", "x", writeContext));
    const outcome = await runEffect(service.delete(scopes, "agent-1/notes.txt"));
    expect(outcome.success).toBe(true);
    const view = await runEffect(service.view(scopes, "agent-1/notes.txt"));
    expect(view.kind).toBe("not_found");
  });

  test("fails for a missing path", async () => {
    const service = makeService();
    const outcome = await runEffect(service.delete(scopes, "agent-1/missing.txt"));
    expect(outcome.success).toBe(false);
  });

  test("refuses to delete a scope's memory root", async () => {
    const service = makeService();
    const outcome = await runEffect(service.delete(scopes, "agent-1"));
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("cannot delete");
  });
});

describe("rename", () => {
  test("renames an existing file", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/old.txt", "x", writeContext));
    const outcome = await runEffect(
      service.rename(scopes, "agent-1/old.txt", "agent-1/new.txt", writeContext),
    );
    expect(outcome.success).toBe(true);
    expect((await runEffect(service.view(scopes, "agent-1/old.txt"))).kind).toBe("not_found");
    expect((await runEffect(service.view(scopes, "agent-1/new.txt"))).kind).toBe("file");
  });

  test("fails when the destination already exists", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/a.txt", "a", writeContext));
    await runEffect(service.create(scopes, "agent-1/b.txt", "b", writeContext));
    const outcome = await runEffect(
      service.rename(scopes, "agent-1/a.txt", "agent-1/b.txt", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("already exists");
  });

  test("fails renaming across scopes", async () => {
    const multiScopes = ["agent-1", "agent-2"];
    const service = makeService();
    await runEffect(service.create(multiScopes, "agent-1/a.txt", "a", writeContext));
    const outcome = await runEffect(
      service.rename(multiScopes, "agent-1/a.txt", "agent-2/a.txt", writeContext),
    );
    expect(outcome.success).toBe(false);
    expect(outcome.message).toContain("across memory scopes");
  });
});

describe("path safety", () => {
  test("rejects .. traversal", async () => {
    const service = makeService();
    const result = await runEither(
      service.create(scopes, "agent-1/../escape.txt", "x", writeContext),
    );
    expect(result._tag).toBe("Left");
  });

  test("rejects a null byte", async () => {
    const service = makeService();
    const result = await runEither(
      service.create(scopes, "agent-1/notes\0.txt", "x", writeContext),
    );
    expect(result._tag).toBe("Left");
  });

  test("rejects paths deeper than the max depth", async () => {
    const service = makeService();
    const result = await runEither(
      service.create(scopes, "agent-1/a/b/c/d/e.txt", "x", writeContext),
    );
    expect(result._tag).toBe("Left");
  });

  test("rejects a path segment longer than the max length", async () => {
    const service = makeService();
    const result = await runEither(
      service.create(scopes, `agent-1/${"x".repeat(200)}.txt`, "x", writeContext),
    );
    expect(result._tag).toBe("Left");
  });

  test("rejects an invalid scope name", async () => {
    const service = makeService();
    const result = await runEither(service.view([".."], ".."));
    expect(result._tag).toBe("Left");
  });

  test("rejects reading through a symlink that escapes the memory root", async () => {
    const service = makeService();
    const scopeRoot = path.join(tmpDir, "agent-1");
    fs.mkdirSync(scopeRoot, { recursive: true });
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-outside-"));
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");
    fs.symlinkSync(outsideDir, path.join(scopeRoot, "link"));

    try {
      const result = await runEither(service.view(scopes, "agent-1/link/secret.txt"));
      expect(result._tag).toBe("Left");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("root listing", () => {
  test("lists the files inside every accessible scope in one call", async () => {
    const service = new MemoryServiceImpl({ baseMemoryDirectory: tmpDir });
    const twoScopes = ["personal", "work"];
    await runEffect(service.create(twoScopes, "personal/prefs.md", "bun over npm", writeContext));
    await runEffect(
      service.create(twoScopes, "personal/people/alex.md", "likes tea", writeContext),
    );
    await runEffect(service.create(twoScopes, "work/status.md", "shipping", writeContext));

    const outcome = await runEffect(service.view(twoScopes, ""));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries.map((entry) => entry.name)).toEqual([
        "personal/",
        "personal/people/",
        "personal/people/alex.md",
        "personal/prefs.md",
        "work/",
        "work/status.md",
      ]);
      const prefs = outcome.entries.find((entry) => entry.name === "personal/prefs.md");
      expect(prefs?.sizeBytes).toBe("bun over npm".length);
    }
  });

  test("does not create a scope directory as a side effect of listing", async () => {
    const service = new MemoryServiceImpl({ baseMemoryDirectory: tmpDir });
    const outcome = await runEffect(service.view(["never-written"], ""));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries).toEqual([
        { name: "never-written/", kind: "directory", sizeBytes: 0 },
      ]);
    }
    expect(fs.existsSync(path.join(tmpDir, "never-written"))).toBe(false);
  });

  test("still lists a scope whose name is not storage-safe, without walking it", async () => {
    const service = new MemoryServiceImpl({ baseMemoryDirectory: tmpDir });
    const outcome = await runEffect(service.view(["../escape"], ""));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries).toEqual([{ name: "../escape/", kind: "directory", sizeBytes: 0 }]);
    }
  });
});

describe("scope byte budget", () => {
  function makeBudgetService(): MemoryServiceImpl {
    return new MemoryServiceImpl({
      baseMemoryDirectory: tmpDir,
      maxTotalBytesPerScope: 100,
      maxFileBytes: 500,
    });
  }

  test("rejects a create that would exceed the total byte budget", async () => {
    const service = makeBudgetService();
    await runEffect(service.create(scopes, "agent-1/a.txt", "A".repeat(60), writeContext));
    const result = await runEither(
      service.create(scopes, "agent-1/b.txt", "B".repeat(50), writeContext),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(String(result.left)).toContain("total memory budget");
    }
  });

  test("rejects an insert that grows a file past the total byte budget", async () => {
    const service = makeBudgetService();
    await runEffect(service.create(scopes, "agent-1/a.txt", "A".repeat(60), writeContext));
    const result = await runEither(
      service.insert(scopes, "agent-1/a.txt", 1, "B".repeat(50), writeContext),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(String(result.left)).toContain("total memory budget");
    }
  });

  test("rejects a str_replace that grows a file past the total byte budget", async () => {
    const service = makeBudgetService();
    await runEffect(service.create(scopes, "agent-1/a.txt", "A".repeat(60), writeContext));
    const result = await runEither(
      service.strReplace(scopes, "agent-1/a.txt", "A".repeat(60), "B".repeat(111), writeContext),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(String(result.left)).toContain("total memory budget");
    }
  });

  test("allows a shrinking edit on a scope already at the budget ceiling", async () => {
    const service = makeBudgetService();
    await runEffect(service.create(scopes, "agent-1/a.txt", "A".repeat(100), writeContext));
    const outcome = await runEffect(
      service.strReplace(scopes, "agent-1/a.txt", "A".repeat(100), "B".repeat(10), writeContext),
    );
    expect(outcome.success).toBe(true);
  });
});

describe("provenance", () => {
  test("records creation, writes, and the writing agent", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.md", "hello", writeContext));
    const provenance = await runEffect(service.provenance(scopes, "agent-1/notes.md"));
    expect(provenance?.writeCount).toBe(1);
    expect(provenance?.writtenBy).toEqual(["agent-1"]);
    expect(provenance?.createdAt).toBe(provenance?.updatedAt);
  });

  test("counts each edit and keeps the original creation time", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.md", "hello", writeContext));
    const created = await runEffect(service.provenance(scopes, "agent-1/notes.md"));
    await runEffect(service.strReplace(scopes, "agent-1/notes.md", "hello", "bye", writeContext));
    const edited = await runEffect(service.provenance(scopes, "agent-1/notes.md"));
    expect(edited?.writeCount).toBe(2);
    expect(edited?.createdAt).toBe(created?.createdAt);
  });

  test("records the subject and trigger supplied on create", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/lessons/moodboard/artboard.md", "artboards autoscale", {
        agentId: "agent-1",
        entry: {
          subject: "artboard-scaling",
          origin: "auto",
          trigger: { kind: "correction", correctedBehavior: "auto-scale the artboard" },
        },
      }),
    );
    const provenance = await runEffect(
      service.provenance(scopes, "agent-1/lessons/moodboard/artboard.md"),
    );
    expect(provenance?.subject).toBe("artboard-scaling");
    expect(provenance?.origin).toBe("auto");
    expect(provenance?.trigger).toEqual({
      kind: "correction",
      correctedBehavior: "auto-scale the artboard",
    });
  });

  test("carries subject, trigger, and credit through a later edit that supplies none", async () => {
    const service = makeService();
    const entryPath = "agent-1/lessons/moodboard/artboard.md";
    await runEffect(
      service.create(scopes, entryPath, "artboards autoscale", {
        agentId: "agent-1",
        entry: {
          subject: "artboard-scaling",
          trigger: { kind: "misfire", toolName: "edit_file", errorClass: "pattern too complex" },
        },
      }),
    );
    await runEffect(
      service.strReplace(scopes, entryPath, "artboards autoscale", "artboards auto-scale", {
        agentId: "agent-1",
      }),
    );
    const provenance = await runEffect(service.provenance(scopes, entryPath));
    expect(provenance?.subject).toBe("artboard-scaling");
    expect(provenance?.trigger).toEqual({
      kind: "misfire",
      toolName: "edit_file",
      errorClass: "pattern too complex",
    });
    expect(provenance?.writeCount).toBe(2);
  });

  test("derives the summary from the entry's first line and refreshes it on edit", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/facts/tz.md", "# Timezone\n\nUser is in Paris", writeContext),
    );
    expect((await runEffect(service.provenance(scopes, "agent-1/facts/tz.md")))?.summary).toBe(
      "Timezone",
    );

    await runEffect(
      service.strReplace(
        scopes,
        "agent-1/facts/tz.md",
        "# Timezone",
        "# Home timezone",
        writeContext,
      ),
    );
    expect((await runEffect(service.provenance(scopes, "agent-1/facts/tz.md")))?.summary).toBe(
      "Home timezone",
    );
  });

  test("keeps subject and trigger when an entry is renamed to another workflow", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/lessons/moodboard/artboard.md", "autoscale", {
        agentId: "agent-1",
        entry: { subject: "artboard-scaling", origin: "auto" },
      }),
    );
    await runEffect(
      service.rename(
        scopes,
        "agent-1/lessons/moodboard/artboard.md",
        "agent-1/lessons/_global/artboard.md",
        writeContext,
      ),
    );
    const provenance = await runEffect(
      service.provenance(scopes, "agent-1/lessons/_global/artboard.md"),
    );
    expect(provenance?.subject).toBe("artboard-scaling");
    expect(provenance?.origin).toBe("auto");
  });

  test("records every agent that has written to a shared scope", async () => {
    const shared = ["team"];
    const service = makeService();
    await runEffect(service.create(shared, "team/status.md", "x", { agentId: "a" }));
    await runEffect(service.insert(shared, "team/status.md", 1, "y", { agentId: "b" }));
    const provenance = await runEffect(service.provenance(shared, "team/status.md"));
    expect(provenance?.writtenBy).toEqual(["a", "b"]);
  });

  test("stamps lastViewedAt when a file is read back", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.md", "hello", writeContext));
    expect((await runEffect(service.provenance(scopes, "agent-1/notes.md")))?.lastViewedAt).toBe(
      undefined,
    );
    await runEffect(service.view(scopes, "agent-1/notes.md"));
    expect(
      (await runEffect(service.provenance(scopes, "agent-1/notes.md")))?.lastViewedAt,
    ).toBeString();
  });

  test("forgets provenance when the file is deleted", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.md", "hello", writeContext));
    await runEffect(service.delete(scopes, "agent-1/notes.md"));
    expect(await runEffect(service.provenance(scopes, "agent-1/notes.md"))).toBe(undefined);
  });

  test("carries provenance across a rename", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/old.md", "hello", writeContext));
    const created = await runEffect(service.provenance(scopes, "agent-1/old.md"));
    await runEffect(service.rename(scopes, "agent-1/old.md", "agent-1/new.md", writeContext));
    expect(await runEffect(service.provenance(scopes, "agent-1/old.md"))).toBe(undefined);
    const moved = await runEffect(service.provenance(scopes, "agent-1/new.md"));
    expect(moved?.createdAt).toBe(created?.createdAt);
  });

  test("the sidecar is invisible to listings and free of the file budget", async () => {
    const service = new MemoryServiceImpl({
      baseMemoryDirectory: tmpDir,
      maxFilesPerScope: 1,
    });
    await runEffect(service.create(scopes, "agent-1/only.md", "hello", writeContext));
    const outcome = await runEffect(service.view(scopes, "agent-1"));
    expect(outcome.kind).toBe("directory");
    if (outcome.kind === "directory") {
      expect(outcome.entries.map((entry) => entry.name)).toEqual(["only.md"]);
    }
  });

  test("returns undefined for a scope outside the accessible set", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/notes.md", "hello", writeContext));
    expect(await runEffect(service.provenance(["other"], "agent-1/notes.md"))).toBe(undefined);
  });
});

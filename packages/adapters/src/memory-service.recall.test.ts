/**
 * Covers scope-aware memory discovery and the snapshot used by opportunity
 * receipts. A snapshot assigns stable IDs without marking a file viewed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  beginMemoryOpportunities,
  completeMemoryOpportunities,
  readMemoryOpportunityReceipts,
} from "@jazz/core/agent/memory-opportunity-receipts";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Effect } from "effect";
import { MemoryServiceImpl } from "./memory-service";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-memory-recall-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runEffect<A>(eff: Effect.Effect<A, unknown, FileSystem.FileSystem>) {
  return Effect.runPromise(eff.pipe(Effect.provide(NodeFileSystem.layer)));
}

function makeService(): MemoryServiceImpl {
  return new MemoryServiceImpl({
    baseMemoryDirectory: tmpDir,
    receiptsDirectory: path.join(tmpDir, ".memory-receipts"),
  });
}

const scopes = ["personal"];
const writeContext = { agentId: "agent-1" } as const;

function writeByHand(relativePath: string, content: string) {
  const absolute = path.join(tmpDir, "personal", relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

describe("standingEntries", () => {
  test("returns always/ entries", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "personal/always/auto-open.md", "auto-open the render", writeContext),
    );
    expect(await runEffect(service.standingEntries(scopes))).toEqual([
      {
        path: "personal/always/auto-open.md",
        scope: "personal",
        topic: undefined,
        summary: "auto-open the render",
      },
    ]);
  });

  test("does not return topic-scoped entries", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "personal/when/moodboard/scale.md", "artboards scale", writeContext),
    );
    expect(await runEffect(service.standingEntries(scopes))).toEqual([]);
  });

  test("ignores topic entries even when always/ entries also exist", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "personal/always/a.md", "always", writeContext));
    for (const topic of ["moodboard", "invoicing", "travel"]) {
      writeByHand(`when/${topic}/x.md`, `${topic} entry`);
    }
    const entries = await runEffect(service.standingEntries(scopes));
    expect(entries.map((entry) => entry.summary)).toEqual(["always"]);
  });

  test("an entry created by hand is returned", async () => {
    const service = makeService();
    writeByHand("always/by-hand.md", "written in an editor\nmore detail\n");
    expect(await runEffect(service.standingEntries(scopes))).toEqual([
      {
        path: "personal/always/by-hand.md",
        scope: "personal",
        topic: undefined,
        summary: "written in an editor",
      },
    ]);
  });

  test("an entry deleted by hand stops being returned", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "personal/always/gone.md", "temporary", writeContext));
    fs.rmSync(path.join(tmpDir, "personal", "always", "gone.md"));
    expect(await runEffect(service.standingEntries(scopes))).toEqual([]);
  });

  test("does not inject files reached through memory symlinks", async () => {
    const service = makeService();
    const outsideFile = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(outsideFile, "external instruction");
    fs.mkdirSync(path.join(tmpDir, "personal", "always"), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(tmpDir, "personal", "always", "linked.md"));

    expect(await runEffect(service.standingEntries(scopes))).toEqual([]);
  });

  test("survives a corrupt sidecar", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "personal/always/a.md", "still here", writeContext));
    fs.writeFileSync(path.join(tmpDir, "personal", ".provenance.json"), "{not json");
    expect(
      (await runEffect(service.standingEntries(scopes))).map((entry) => entry.summary),
    ).toEqual(["still here"]);
  });

  test("skips an entry with no readable first line", async () => {
    const service = makeService();
    writeByHand("always/blank.md", "   \n\n");
    expect(await runEffect(service.standingEntries(scopes))).toEqual([]);
  });

  test("takes the first non-empty line as the summary", async () => {
    const service = makeService();
    writeByHand("always/headed.md", "\n# Auto-open renders\n\nlonger explanation\n");
    expect(
      (await runEffect(service.standingEntries(scopes))).map((entry) => entry.summary),
    ).toEqual(["Auto-open renders"]);
  });

  test("returns entries sorted by filename", async () => {
    const service = makeService();
    writeByHand("always/z-last.md", "last");
    writeByHand("always/a-first.md", "first");
    const summaries = (await runEffect(service.standingEntries(scopes))).map(
      (entry) => entry.summary,
    );
    expect(summaries).toEqual(["first", "last"]);
  });

  test("spans multiple scopes", async () => {
    const service = makeService();
    const multiScopes = ["personal", "work"];
    fs.mkdirSync(path.join(tmpDir, "work", "always"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "work", "always", "note.md"), "work note");
    writeByHand("always/home.md", "home note");
    const entries = await runEffect(service.standingEntries(multiScopes));
    expect(entries.map((entry) => entry.summary)).toEqual(["home note", "work note"]);
  });

  test("returns conditional entries with scope and topic", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "personal/when/colleagues/tone.md", "Be professional", writeContext),
    );
    expect(await runEffect(service.conditionalEntries(scopes))).toEqual([
      {
        path: "personal/when/colleagues/tone.md",
        scope: "personal",
        topic: "colleagues",
        summary: "Be professional",
      },
    ]);
  });

  test("does not discover conditional memories through a linked topic", async () => {
    const service = makeService();
    const outsideTopic = path.join(tmpDir, "outside-topic");
    fs.mkdirSync(outsideTopic);
    fs.writeFileSync(path.join(outsideTopic, "instruction.md"), "external instruction");
    fs.mkdirSync(path.join(tmpDir, "personal", "when"), { recursive: true });
    fs.symlinkSync(outsideTopic, path.join(tmpDir, "personal", "when", "food"));

    expect(await runEffect(service.conditionalEntries(scopes))).toEqual([]);
  });
});

describe("snapshotEntries", () => {
  test("skips a linked scope without reading or writing its provenance", async () => {
    const service = makeService();
    const outside = path.join(tmpDir, "outside-scope");
    fs.mkdirSync(path.join(outside, "always"), { recursive: true });
    fs.writeFileSync(path.join(outside, "always", "note.md"), "external instruction");
    fs.writeFileSync(path.join(outside, ".provenance.json"), "{invalid json");
    fs.symlinkSync(outside, path.join(tmpDir, "personal"));

    expect(await runEffect(service.snapshotEntries(scopes))).toEqual({
      entries: [],
      unreadableScopes: [],
    });
    expect(fs.readFileSync(path.join(outside, ".provenance.json"), "utf8")).toBe("{invalid json");
  });

  test("forget erases retained receipts for the scope before removing memory", async () => {
    const receiptsDirectory = path.join(tmpDir, "memory-receipts");
    const service = new MemoryServiceImpl({
      baseMemoryDirectory: path.join(tmpDir, "memory"),
      receiptsDirectory,
    });
    expect(
      (
        await runEffect(
          service.create(scopes, "personal/when/food/fruit.md", "banana", writeContext),
        )
      ).success,
    ).toBe(true);
    const { entries } = await runEffect(service.snapshotEntries(scopes));
    const entryId = entries[0]?.entryId ?? "";
    const messages = [{ role: "user" as const, content: "shopping list" }];
    const tickets = await runEffect(
      beginMemoryOpportunities({
        runId: "run-forget",
        iteration: 0,
        entries,
        messages,
        receiptsDirectory,
      }),
    );
    await runEffect(completeMemoryOpportunities(tickets, messages));
    const receiptsFor = () =>
      runEffect(readMemoryOpportunityReceipts("personal", entryId, 5, receiptsDirectory));
    expect(await receiptsFor()).toHaveLength(1);
    expect((await runEffect(service.delete(scopes, "personal/when/food/fruit.md"))).success).toBe(
      true,
    );
    expect(await receiptsFor()).toEqual([]);
  });

  test("assigns a stable ID to a hand-edited file, preserves it on rename, and versions edits", async () => {
    const service = makeService();
    writeByHand("when/shopping/fruit.md", "My favorite fruit is banana");
    const first = (await runEffect(service.snapshotEntries(scopes))).entries[0];
    expect(first?.entryId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first?.topic).toBe("shopping");
    expect(
      (await runEffect(service.provenance(scopes, first?.path ?? "")))?.lastViewedAt,
    ).toBeUndefined();
    const second = (await runEffect(service.snapshotEntries(scopes))).entries[0];
    expect(second?.entryId).toBe(first?.entryId);
    expect(second?.entryContentHash).toBe(first?.entryContentHash);

    expect(
      (
        await runEffect(
          service.rename(
            scopes,
            "personal/when/shopping/fruit.md",
            "personal/when/food/fruit.md",
            writeContext,
          ),
        )
      ).success,
    ).toBe(true);
    const renamed = (await runEffect(service.snapshotEntries(scopes))).entries[0];
    expect(renamed?.entryId).toBe(first?.entryId);
    expect(renamed?.path).toBe("personal/when/food/fruit.md");
    expect(
      (
        await runEffect(
          service.strReplace(scopes, renamed?.path ?? "", "banana", "mango", writeContext),
        )
      ).success,
    ).toBe(true);
    const updated = (await runEffect(service.snapshotEntries(scopes))).entries[0];
    expect(updated?.entryId).toBe(first?.entryId);
    expect(updated?.entryContentHash).not.toBe(first?.entryContentHash);
  });

  test("includes eligible unshown files only from allowed scopes", async () => {
    const service = makeService();
    writeByHand("when/shopping/fruit.md", "banana");
    fs.mkdirSync(path.join(tmpDir, "work", "when", "shopping"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "work", "when", "shopping", "private.md"), "secret");
    expect(
      (await runEffect(service.snapshotEntries(scopes))).entries.map((entry) => entry.path),
    ).toEqual(["personal/when/shopping/fruit.md"]);
  });
});

describe("a memory base reached through a symlink", () => {
  test("still lists and snapshots its scopes", async () => {
    const realBase = path.join(tmpDir, "synced-memory");
    const linkedBase = path.join(tmpDir, "linked-memory");
    fs.mkdirSync(path.join(realBase, "personal", "always"), { recursive: true });
    fs.writeFileSync(path.join(realBase, "personal", "always", "tone.md"), "Reply concisely");
    fs.symlinkSync(realBase, linkedBase);
    const service = new MemoryServiceImpl({
      baseMemoryDirectory: linkedBase,
      receiptsDirectory: path.join(tmpDir, "receipts"),
    });

    const root = await runEffect(service.view(scopes, ""));
    expect(root.kind === "directory" ? root.entries.map((entry) => entry.name) : []).toContain(
      "personal/always/tone.md",
    );
    const { entries } = await runEffect(service.snapshotEntries(scopes));
    expect(entries.map((entry) => entry.path)).toEqual(["personal/always/tone.md"]);
  });
});

describe("snapshotEntries with an unreadable scope", () => {
  test("reports the scope and keeps the others", async () => {
    const service = makeService();
    writeByHand("always/tone.md", "Reply concisely");
    const workScope = path.join(tmpDir, "work");
    fs.mkdirSync(path.join(workScope, "always"), { recursive: true });
    fs.writeFileSync(path.join(workScope, "always", "sign-off.md"), "Sign as the team");
    fs.mkdirSync(path.join(tmpDir, ".memory-receipts", "work"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".memory-receipts", "work", ".epoch"));

    const snapshot = await runEffect(service.snapshotEntries(["personal", "work"]));
    expect(snapshot.entries.map((entry) => entry.path)).toEqual(["personal/always/tone.md"]);
    expect(snapshot.unreadableScopes).toEqual(["work"]);
  });
});

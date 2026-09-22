import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
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
  return new MemoryServiceImpl({ baseMemoryDirectory: tmpDir });
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
});

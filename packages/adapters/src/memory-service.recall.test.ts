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

const scopes = ["agent-1"];
const writeContext = { agentId: "agent-1" } as const;

function writeByHand(relativePath: string, content: string) {
  const absolute = path.join(tmpDir, "agent-1", relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

describe("what is in force", () => {
  test("an always entry applies with no topic active", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/always/auto-open.md", "auto-open the render", writeContext),
    );
    expect(await runEffect(service.inForce(scopes, []))).toEqual([
      { path: "agent-1/always/auto-open.md", topic: undefined, summary: "auto-open the render" },
    ]);
  });

  test("a topic entry applies only when that topic is active", async () => {
    const service = makeService();
    await runEffect(
      service.create(scopes, "agent-1/when/moodboard/scale.md", "artboards scale", writeContext),
    );
    expect(await runEffect(service.inForce(scopes, []))).toEqual([]);
    expect(
      (await runEffect(service.inForce(scopes, ["moodboard"]))).map((entry) => entry.topic),
    ).toEqual(["moodboard"]);
  });

  test("reads only the directories that matter, not the whole store", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/always/a.md", "always", writeContext));
    for (const topic of ["moodboard", "invoicing", "travel"]) {
      writeByHand(`when/${topic}/x.md`, `${topic} entry`);
    }
    const entries = await runEffect(service.inForce(scopes, ["moodboard"]));
    expect(entries.map((entry) => entry.summary)).toEqual(["always", "moodboard entry"]);
  });

  test("an entry created by hand is in force, with no tool involved", async () => {
    const service = makeService();
    writeByHand("always/by-hand.md", "written in an editor\nmore detail\n");
    expect(await runEffect(service.inForce(scopes, []))).toEqual([
      { path: "agent-1/always/by-hand.md", topic: undefined, summary: "written in an editor" },
    ]);
  });

  test("an entry deleted by hand stops being in force", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/always/gone.md", "temporary", writeContext));
    fs.rmSync(path.join(tmpDir, "agent-1", "always", "gone.md"));
    expect(await runEffect(service.inForce(scopes, []))).toEqual([]);
  });

  test("a directory removed by hand takes its entries with it", async () => {
    const service = makeService();
    writeByHand("when/moodboard/a.md", "scale it");
    fs.rmSync(path.join(tmpDir, "agent-1", "when", "moodboard"), { recursive: true });
    expect(await runEffect(service.inForce(scopes, ["moodboard"]))).toEqual([]);
  });

  test("survives a corrupt sidecar, which recall never consults", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/always/a.md", "still here", writeContext));
    fs.writeFileSync(path.join(tmpDir, "agent-1", ".provenance.json"), "{not json");
    expect((await runEffect(service.inForce(scopes, []))).map((entry) => entry.summary)).toEqual([
      "still here",
    ]);
  });

  test("skips an entry with no readable first line rather than injecting a blank", async () => {
    const service = makeService();
    writeByHand("always/blank.md", "   \n\n");
    expect(await runEffect(service.inForce(scopes, []))).toEqual([]);
  });

  test("takes the first non-empty line as the point of the entry", async () => {
    const service = makeService();
    writeByHand("always/headed.md", "\n# Auto-open renders\n\nlonger explanation\n");
    expect((await runEffect(service.inForce(scopes, []))).map((entry) => entry.summary)).toEqual([
      "Auto-open renders",
    ]);
  });
});

describe("topics", () => {
  test("lists the topics the store holds entries for", async () => {
    const service = makeService();
    writeByHand("when/moodboard/x.md", "entry");
    writeByHand("when/invoicing/x.md", "entry");
    expect(await runEffect(service.topics(scopes))).toEqual(["invoicing", "moodboard"]);
  });

  test("is empty when nothing is topic-scoped", async () => {
    const service = makeService();
    await runEffect(service.create(scopes, "agent-1/always/a.md", "x", writeContext));
    expect(await runEffect(service.topics(scopes))).toEqual([]);
  });

  test("finds a topic directory created by hand", async () => {
    const service = makeService();
    writeByHand("when/gardening/notes.md", "water on tuesdays");
    expect(await runEffect(service.topics(scopes))).toEqual(["gardening"]);
  });
});

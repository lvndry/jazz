import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  appendJournalEntry,
  clearWorkState,
  journalPath,
  pruneJournal,
  readJournal,
  workStateSizeBytes,
} from "./work-journal";

const runEffect = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect);

function entry(summary: string) {
  return {
    recordedAt: "2026-08-15T10:00:00.000Z",
    tokensBefore: 100_000,
    tokensAfter: 30_000,
    messagesBefore: 64,
    messagesAfter: 12,
    summary,
  };
}

describe("work journal", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-journal-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("returns an empty journal when nothing has been written", async () => {
    expect(await runEffect(readJournal("agent-1", "conv-1"))).toEqual([]);
  });

  it("appends entries and reads them back oldest first", async () => {
    await runEffect(appendJournalEntry("agent-1", "conv-1", entry("first")));
    await runEffect(appendJournalEntry("agent-1", "conv-1", entry("second")));

    const entries = await runEffect(readJournal("agent-1", "conv-1"));
    expect(entries.map((item) => item.summary)).toEqual(["first", "second"]);
    expect(entries[0]?.tokensBefore).toBe(100_000);
  });

  it("keeps journals separate per conversation and per agent", async () => {
    await runEffect(appendJournalEntry("agent-1", "conv-1", entry("one")));
    await runEffect(appendJournalEntry("agent-1", "conv-2", entry("two")));
    await runEffect(appendJournalEntry("agent-2", "conv-1", entry("three")));

    expect((await runEffect(readJournal("agent-1", "conv-1")))[0]?.summary).toBe("one");
    expect((await runEffect(readJournal("agent-1", "conv-2")))[0]?.summary).toBe("two");
    expect((await runEffect(readJournal("agent-2", "conv-1")))[0]?.summary).toBe("three");
  });

  it("survives a torn final line rather than losing the file", async () => {
    await runEffect(appendJournalEntry("agent-1", "conv-1", entry("intact")));
    await nodeFs.appendFile(journalPath("agent-1", "conv-1"), '{"recordedAt":"2026', "utf-8");

    const entries = await runEffect(readJournal("agent-1", "conv-1"));
    expect(entries.length).toBe(1);
    expect(entries[0]?.summary).toBe("intact");
  });

  it("reports failure instead of throwing when the path cannot be written", async () => {
    process.env["JAZZ_HOME"] = "/proc/nonexistent-jazz-home";
    expect(await runEffect(appendJournalEntry("agent-1", "conv-1", entry("nope")))).toBe(false);
  });
});

describe("work state lifecycle", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-journal-gc-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("reports zero size for a conversation with no state", async () => {
    expect(await runEffect(workStateSizeBytes("agent-1", "conv-1"))).toBe(0);
  });

  it("clears a conversation's state without touching its neighbours", async () => {
    await runEffect(appendJournalEntry("agent-1", "conv-1", entry("one")));
    await runEffect(appendJournalEntry("agent-1", "conv-2", entry("two")));

    expect(await runEffect(clearWorkState("agent-1", "conv-1"))).toBe(true);
    expect(await runEffect(readJournal("agent-1", "conv-1"))).toEqual([]);
    expect((await runEffect(readJournal("agent-1", "conv-2")))[0]?.summary).toBe("two");
  });

  it("clearing a conversation that has no state is not an error", async () => {
    expect(await runEffect(clearWorkState("agent-1", "never-existed"))).toBe(true);
  });

  it("prunes oldest-first once past the cap, keeping the newest records", async () => {
    for (let index = 0; index < 20; index++) {
      await runEffect(
        appendJournalEntry("agent-1", "conv-1", entry(`record ${index} ` + "x".repeat(500))),
      );
    }

    const dropped = await runEffect(pruneJournal("agent-1", "conv-1", 2_000));
    expect(dropped).toBeGreaterThan(0);

    const remaining = await runEffect(readJournal("agent-1", "conv-1"));
    expect(remaining.length).toBeLessThan(20);
    // The newest record is the one that describes where the task actually is.
    expect(remaining[remaining.length - 1]?.summary).toContain("record 19");
  });

  it("leaves the journal alone while it is under the cap", async () => {
    await runEffect(appendJournalEntry("agent-1", "conv-1", entry("small")));
    expect(await runEffect(pruneJournal("agent-1", "conv-1"))).toBe(0);
    expect((await runEffect(readJournal("agent-1", "conv-1"))).length).toBe(1);
  });
});

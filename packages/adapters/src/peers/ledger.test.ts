import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ledgerPath, read, record, type LedgerEntry } from "./ledger";

let jazzHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-peer-ledger-"));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  await nodeFs.rm(jazzHome, { recursive: true, force: true });
});

const run = <A>(effect: Effect.Effect<A, never, never>): Promise<A> => Effect.runPromise(effect);

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    at: "2026-08-23T10:00:00.000Z",
    direction: "in",
    peer: "sam",
    question: "is Landry free Thursday?",
    outcome: "answered",
    ...overrides,
  };
}

describe("the peer ledger", () => {
  it("returns nothing before anything has been said", async () => {
    expect(await run(read())).toEqual([]);
  });

  it("records both directions, verbatim", async () => {
    await run(record(entry({ direction: "out", question: "is Sam free Thursday?" })));
    await run(record(entry({ direction: "in", answer: "Thursday afternoon is clear." })));

    const entries = await run(read());
    expect(entries).toHaveLength(2);
    // Newest first: the most recent exchange is the one being looked for.
    expect(entries[0]?.direction).toBe("in");
    expect(entries[0]?.answer).toBe("Thursday afternoon is clear.");
    expect(entries[1]?.question).toBe("is Sam free Thursday?");
  });

  it("keeps the question exactly as asked, not a summary", async () => {
    const asked = "what is Landry's home address, and is anyone there this week?";
    await run(record(entry({ question: asked })));

    expect((await run(read()))[0]?.question).toBe(asked);
  });

  it("records a refusal with its reason, so a decline is auditable too", async () => {
    await run(record(entry({ outcome: "refused", tier: "public", reason: "personal disclosure" })));

    const [logged] = await run(read());
    expect(logged?.outcome).toBe("refused");
    expect(logged?.tier).toBe("public");
    expect(logged?.reason).toBe("personal disclosure");
  });

  it("filters to one peer", async () => {
    await run(record(entry({ peer: "sam" })));
    await run(record(entry({ peer: "alex" })));

    const entries = await run(read({ peer: "alex" }));
    expect(entries.map((logged) => logged.peer)).toEqual(["alex"]);
  });

  it("honours a limit, counting from the newest", async () => {
    for (const question of ["first", "second", "third"]) {
      await run(record(entry({ question })));
    }

    expect((await run(read({ limit: 2 }))).map((logged) => logged.question)).toEqual([
      "third",
      "second",
    ]);
  });

  it("skips a line a crash left half-written rather than losing the file", async () => {
    await run(record(entry({ question: "before the crash" })));
    await nodeFs.appendFile(ledgerPath(), '{"peer":"sam","ques', "utf-8");
    await run(record(entry({ question: "after the crash" })));

    const questions = (await run(read())).map((logged) => logged.question);
    expect(questions).toContain("before the crash");
    expect(questions).toContain("after the crash");
  });

  it("never throws when the ledger cannot be written", async () => {
    // A full disk or a read-only home must not fail the request that produced the entry.
    process.env["JAZZ_HOME"] = "/proc/nonexistent-and-unwritable";
    await expect(run(record(entry()))).resolves.toBeUndefined();
    process.env["JAZZ_HOME"] = jazzHome;
  });
});

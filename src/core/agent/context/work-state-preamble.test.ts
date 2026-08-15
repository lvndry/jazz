import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { appendJournalEntry } from "./work-journal";
import { buildWorkStatePreamble } from "./work-state-preamble";

const modelHint = { provider: "openai", modelId: "gpt-4o" };
const runEffect = <A>(effect: Effect.Effect<A, never, never>): Promise<A> =>
  Effect.runPromise(effect);

function entry(summary: string, recordedAt: string) {
  return {
    recordedAt,
    tokensBefore: 100_000,
    tokensAfter: 30_000,
    messagesBefore: 64,
    messagesAfter: 12,
    summary,
  };
}

describe("work state preamble", () => {
  let jazzHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-preamble-"));
    previousHome = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = jazzHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = previousHome;
    await nodeFs.rm(jazzHome, { recursive: true, force: true });
  });

  it("returns nothing when the conversation has no journal", async () => {
    const preamble = await runEffect(buildWorkStatePreamble("agent-1", "conv-1", { modelHint }));
    expect(preamble).toBeUndefined();
  });

  it("recovers what compaction dropped", async () => {
    await runEffect(
      appendJournalEntry(
        "agent-1",
        "conv-1",
        entry("Migrated auth module; tests failing on token refresh.", "2026-08-15T10:00:00.000Z"),
      ),
    );

    const preamble = await runEffect(buildWorkStatePreamble("agent-1", "conv-1", { modelHint }));

    expect(preamble?.role).toBe("assistant");
    expect(preamble?.content).toContain("Migrated auth module");
    expect(preamble?.content).toContain("token refresh");
  });

  it("frames the records as claims to verify rather than fact", async () => {
    await runEffect(
      appendJournalEntry("agent-1", "conv-1", entry("all done", "2026-08-15T10:00:00.000Z")),
    );

    const preamble = await runEffect(buildWorkStatePreamble("agent-1", "conv-1", { modelHint }));
    expect(preamble?.content).toContain("claims to verify");
  });

  it("keeps the newest records and drops older ones to stay in budget", async () => {
    for (let index = 0; index < 10; index++) {
      await runEffect(
        appendJournalEntry(
          "agent-1",
          "conv-1",
          entry(`record ${index} ` + "detail ".repeat(200), `2026-08-15T10:0${index}:00.000Z`),
        ),
      );
    }

    const preamble = await runEffect(
      buildWorkStatePreamble("agent-1", "conv-1", { modelHint, tokenBudget: 500 }),
    );

    expect(preamble?.content).toContain("record 9");
    expect(preamble?.content).not.toContain("record 0 ");
    expect(preamble?.content).toContain("omitted to stay within budget");
  });

  it("keeps at least the most recent record even when it alone exceeds the budget", async () => {
    await runEffect(
      appendJournalEntry(
        "agent-1",
        "conv-1",
        entry("huge " + "detail ".repeat(5000), "2026-08-15T10:00:00.000Z"),
      ),
    );

    const preamble = await runEffect(
      buildWorkStatePreamble("agent-1", "conv-1", { modelHint, tokenBudget: 10 }),
    );
    expect(preamble?.content).toContain("huge");
  });
});

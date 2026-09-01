import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { record as recordLedger } from "@jazz/adapters/peers/ledger";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Duration, Effect, Fiber } from "effect";
import { peerLogCommand } from "./peers";

let jazzHome: string;
let previousHome: string | undefined;
let written: string[] = [];
let originalWrite: typeof process.stdout.write;

beforeEach(async () => {
  jazzHome = await nodeFs.mkdtemp(path.join(os.tmpdir(), "jazz-peers-log-"));
  previousHome = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = jazzHome;
  written = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    written.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdout.write = originalWrite;
  if (previousHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = previousHome;
  await nodeFs.rm(jazzHome, { recursive: true, force: true });
});

function output(): string {
  return written.join("");
}

describe("jazz peers log", () => {
  it("reports nothing to show against an empty ledger", async () => {
    await Effect.runPromise(peerLogCommand({ json: false, limit: 50, follow: false }));
    expect(output()).toContain("Nothing has been said to or by a peer.");
  });

  it("prints an existing entry once, without following, when --follow is not set", async () => {
    await Effect.runPromise(
      recordLedger({
        at: new Date().toISOString(),
        direction: "in",
        peer: "sam",
        question: "what's on the calendar tomorrow?",
        outcome: "answered",
        answer: "nothing scheduled",
      }),
    );

    await Effect.runPromise(peerLogCommand({ json: false, limit: 50, follow: false }));
    expect(output()).toContain("what's on the calendar tomorrow?");
    expect(output()).toContain("nothing scheduled");
    expect(output()).not.toContain("watching for new entries");
  });

  it("--follow prints new entries as they land, without reprinting old ones", async () => {
    await Effect.runPromise(
      recordLedger({
        at: new Date(Date.now() - 1000).toISOString(),
        direction: "in",
        peer: "sam",
        question: "first question",
        outcome: "answered",
        answer: "first answer",
      }),
    );

    const fiber = Effect.runFork(
      peerLogCommand({
        json: false,
        limit: 50,
        follow: true,
        pollInterval: Duration.millis(20),
      }),
    );

    // Let the initial read happen before appending anything new.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(output()).toContain("first question");
    expect(output()).toContain("watching for new entries");

    await Effect.runPromise(
      recordLedger({
        at: new Date().toISOString(),
        direction: "in",
        peer: "sam",
        question: "second question",
        outcome: "parked",
        reason: "why do you ask?",
      }),
    );

    // A couple of poll cycles at the fast interval, well under the real 2s default.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await Effect.runPromise(Fiber.interrupt(fiber));

    const seenSoFar = output();
    expect(seenSoFar).toContain("second question");
    expect(seenSoFar).toContain("parked");
    expect(seenSoFar).toContain("why do you ask?");
    // The first entry appears exactly once — the follow loop must not reprint what the
    // initial read already showed.
    expect(seenSoFar.split("first question")).toHaveLength(2);
  });
});

import { describe, expect, it } from "bun:test";
import { createStreamPacer, REVEAL_FRAME_MS, type PacerTimers } from "./stream-pacer";

/** A clock and a frame timer the test advances by hand. */
function manualTimers(): PacerTimers & { advance(ms: number): void; running(): boolean } {
  let now = 0;
  let tick: (() => void) | undefined;
  return {
    now: () => now,
    every: (_intervalMs, callback) => {
      tick = callback;
      return () => {
        tick = undefined;
      };
    },
    advance(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += REVEAL_FRAME_MS) {
        now += REVEAL_FRAME_MS;
        tick?.();
      }
    },
    running: () => tick !== undefined,
  };
}

function recorder() {
  const applied: string[] = [];
  return { applied, apply: (_kind: string, delta: string) => applied.push(delta) };
}

const BURST = "the model sent this whole paragraph in a single chunk ".repeat(6);

describe("stream pacer", () => {
  it("passes deltas straight through while unpaced", () => {
    const { applied, apply } = recorder();
    const pacer = createStreamPacer(apply, manualTimers());
    pacer.receive("response", "hello ");
    pacer.receive("response", "world");
    expect(applied.join("")).toBe("hello world");
  });

  it("reveals a burst over several frames, in order, at word ends", () => {
    const timers = manualTimers();
    const { applied, apply } = recorder();
    const pacer = createStreamPacer(apply, timers);
    pacer.setPaced(true);
    pacer.receive("response", BURST);
    expect(applied.join("")).toBe("");
    timers.advance(REVEAL_FRAME_MS * 3);
    const partway = applied.join("");
    expect(partway.length).toBeGreaterThan(0);
    expect(partway.length).toBeLessThan(BURST.length);
    expect(BURST.startsWith(partway)).toBe(true);
    // The cut lands at the end of a word, never inside one.
    expect(/\s/.test(BURST[partway.length] ?? " ") || /\s$/.test(partway)).toBe(true);
    timers.advance(1_000);
    expect(applied.join("")).toBe(BURST);
    expect(timers.running()).toBe(false);
  });

  it("shows everything at once when flushed or unpaced", () => {
    const timers = manualTimers();
    const { applied, apply } = recorder();
    const pacer = createStreamPacer(apply, timers);
    pacer.setPaced(true);
    pacer.receive("response", BURST);
    pacer.flush();
    expect(applied.join("")).toBe(BURST);
    pacer.receive("response", " more");
    pacer.setPaced(false);
    expect(applied.join("")).toBe(`${BURST} more`);
  });

  it("finishes one kind of stream before starting the next", () => {
    const timers = manualTimers();
    const applied: string[] = [];
    const pacer = createStreamPacer((kind: string, delta: string) => {
      applied.push(`${kind}:${delta}`);
    }, timers);
    pacer.setPaced(true);
    pacer.receive("reasoning", "weighing it up");
    pacer.receive("response", "Here");
    expect(applied[0]).toBe("reasoning:weighing it up");
  });

  it("starts a new stream after end, and drops a backlog on reset", () => {
    const timers = manualTimers();
    const { applied, apply } = recorder();
    const pacer = createStreamPacer(apply, timers);
    pacer.setPaced(true);
    pacer.receive("response", "first answer");
    pacer.end();
    pacer.receive("response", "second");
    pacer.reset();
    timers.advance(1_000);
    expect(applied.join("|")).toBe("first answer");
  });
});

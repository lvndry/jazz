/** Pacer tests use one source fixture and assert absolute cursors and lifecycle guards. */
import { describe, expect, it } from "bun:test";
import {
  createStreamPacer,
  REVEAL_FRAME_MS,
  type PacerTimers,
  type StreamSource,
} from "./stream-pacer";

function manualTimers(): PacerTimers & {
  advance(ms: number): void;
  running(): boolean;
  staleTick(): void;
} {
  let now = 0;
  let tick: (() => void) | undefined;
  let stale: (() => void) | undefined;
  return {
    now: () => now,
    every: (_intervalMs, callback) => {
      tick = callback;
      stale = callback;
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
    staleTick: () => stale?.(),
  };
}
function fixture() {
  let source: StreamSource | null = null;
  const events: Array<{ id: string; length: number }> = [];
  const timers = manualTimers();
  const pacer = createStreamPacer(
    () => source,
    (id, length) => events.push({ id, length }),
    timers,
  );
  return {
    pacer,
    timers,
    events,
    accept(id: string, text: string) {
      if (source?.id !== id) pacer.flush();
      source = { id, text };
      pacer.receive();
    },
    replace(id: string, text: string) {
      source = { id, text };
    },
    visible: () => events.at(-1)?.length ?? 0,
  };
}
const BURST = "the model sent this whole paragraph in a single chunk ".repeat(6);

describe("stream pacer", () => {
  it("publishes an absolute cursor immediately while unpaced", () => {
    const f = fixture();
    f.accept("answer", "hello ");
    f.accept("answer", "hello world");
    expect(f.events).toEqual([
      { id: "answer", length: 6 },
      { id: "answer", length: 11 },
    ]);
    expect(f.timers.running()).toBe(false);
  });
  it("reveals a source over several frames at word boundaries", () => {
    const f = fixture();
    f.pacer.setPaced(true);
    f.accept("answer", BURST);
    expect(f.events).toHaveLength(0);
    f.timers.advance(REVEAL_FRAME_MS * 3);
    expect(f.visible()).toBeGreaterThan(0);
    expect(f.visible()).toBeLessThan(BURST.length);
    expect(/\s/.test(BURST[f.visible()] ?? " ") || /\s$/.test(BURST.slice(0, f.visible()))).toBe(
      true,
    );
    f.timers.advance(1000);
    expect(f.visible()).toBe(BURST.length);
    expect(f.timers.running()).toBe(false);
  });
  it("flushes before switching sources and follows the replacement identity", () => {
    const f = fixture();
    f.pacer.setPaced(true);
    f.accept("thought", "weighing it up");
    f.accept("answer", "Here");
    expect(f.events).toEqual([{ id: "thought", length: 14 }]);
    f.pacer.end();
    expect(f.events.at(-1)).toEqual({ id: "answer", length: 4 });
  });
  it("switches between paced and immediate reveal without replaying source text", () => {
    const f = fixture();
    f.accept("answer", "before ");
    f.pacer.setPaced(true);
    f.accept("answer", `before ${BURST}`);
    f.pacer.setPaced(false);
    expect(f.visible()).toBe(`before ${BURST}`.length);
    f.accept("answer", `before ${BURST} more`);
    expect(f.visible()).toBe(`before ${BURST} more`.length);
    expect(f.timers.running()).toBe(false);
  });
  it("reset invalidates a timer callback even if cancellation was too late", () => {
    const f = fixture();
    f.pacer.setPaced(true);
    f.accept("old", BURST);
    f.pacer.reset();
    f.replace("new", "new source");
    f.timers.staleTick();
    f.timers.advance(1000);
    expect(f.events).toHaveLength(0);
  });
  it("a changed source getter cannot publish the old timer's cursor into a new document", () => {
    const f = fixture();
    f.pacer.setPaced(true);
    f.accept("old", BURST);
    f.replace("new", "new source");
    f.timers.advance(REVEAL_FRAME_MS);
    expect(f.events).toHaveLength(0);
    expect(f.timers.running()).toBe(false);
  });
});

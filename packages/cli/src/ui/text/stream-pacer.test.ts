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
      if (source?.id !== id) {
        pacer.flush();
      }
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
    const pacerFixture = fixture();
    pacerFixture.accept("answer", "hello ");
    pacerFixture.accept("answer", "hello world");
    expect(pacerFixture.events).toEqual([
      { id: "answer", length: 6 },
      { id: "answer", length: 11 },
    ]);
    expect(pacerFixture.timers.running()).toBe(false);
  });
  it("reveals a source over several frames at word boundaries", () => {
    const pacerFixture = fixture();
    pacerFixture.pacer.setPaced(true);
    pacerFixture.accept("answer", BURST);
    expect(pacerFixture.events).toHaveLength(0);
    pacerFixture.timers.advance(REVEAL_FRAME_MS * 3);
    expect(pacerFixture.visible()).toBeGreaterThan(0);
    expect(pacerFixture.visible()).toBeLessThan(BURST.length);
    expect(
      /\s/.test(BURST[pacerFixture.visible()] ?? " ") ||
        /\s$/.test(BURST.slice(0, pacerFixture.visible())),
    ).toBe(true);
    pacerFixture.timers.advance(1000);
    expect(pacerFixture.visible()).toBe(BURST.length);
    expect(pacerFixture.timers.running()).toBe(false);
  });
  it("flushes before switching sources and follows the replacement identity", () => {
    const pacerFixture = fixture();
    pacerFixture.pacer.setPaced(true);
    pacerFixture.accept("thought", "weighing it up");
    pacerFixture.accept("answer", "Here");
    expect(pacerFixture.events).toEqual([{ id: "thought", length: 14 }]);
    pacerFixture.pacer.end();
    expect(pacerFixture.events.at(-1)).toEqual({ id: "answer", length: 4 });
  });
  it("switches between paced and immediate reveal without replaying source text", () => {
    const pacerFixture = fixture();
    pacerFixture.accept("answer", "before ");
    pacerFixture.pacer.setPaced(true);
    pacerFixture.accept("answer", `before ${BURST}`);
    pacerFixture.pacer.setPaced(false);
    expect(pacerFixture.visible()).toBe(`before ${BURST}`.length);
    pacerFixture.accept("answer", `before ${BURST} more`);
    expect(pacerFixture.visible()).toBe(`before ${BURST} more`.length);
    expect(pacerFixture.timers.running()).toBe(false);
  });
  it("reset invalidates a timer callback even if cancellation was too late", () => {
    const pacerFixture = fixture();
    pacerFixture.pacer.setPaced(true);
    pacerFixture.accept("old", BURST);
    pacerFixture.pacer.reset();
    pacerFixture.replace("new", "new source");
    pacerFixture.timers.staleTick();
    pacerFixture.timers.advance(1000);
    expect(pacerFixture.events).toHaveLength(0);
  });
  it("a changed source getter cannot publish the old timer's cursor into a new document", () => {
    const pacerFixture = fixture();
    pacerFixture.pacer.setPaced(true);
    pacerFixture.accept("old", BURST);
    pacerFixture.replace("new", "new source");
    pacerFixture.timers.advance(REVEAL_FRAME_MS);
    expect(pacerFixture.events).toHaveLength(0);
    expect(pacerFixture.timers.running()).toBe(false);
  });
});

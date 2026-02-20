import { describe, expect, test } from "bun:test";
import {
  applyTextChunkOrdered,
  MAX_LIVE_TEXT_CHARS,
  type TextChunkState,
  type TextChunkEvent,
} from "./stream-text-order";

function state(liveText: string, lastAppliedSequence: number): TextChunkState {
  return { liveText, lastAppliedSequence };
}

function event(sequence: number, accumulated: string): TextChunkEvent {
  return { sequence, accumulated };
}

describe("applyTextChunkOrdered", () => {
  test("applies chunk when sequence is greater than lastApplied", () => {
    const result = applyTextChunkOrdered(state("", -1), event(0, "Hello"));
    expect(result.liveText).toBe("Hello");
    expect(result.lastAppliedSequence).toBe(0);
  });

  test("applies chunk when sequence is greater than current lastApplied", () => {
    const result = applyTextChunkOrdered(state("Hello", 0), event(1, "Hello world"));
    expect(result.liveText).toBe("Hello world");
    expect(result.lastAppliedSequence).toBe(1);
  });

  test("ignores stale chunk (sequence less than lastApplied)", () => {
    const result = applyTextChunkOrdered(state("Hello world", 2), event(1, "Hello"));
    expect(result.liveText).toBe("Hello world");
    expect(result.lastAppliedSequence).toBe(2);
  });

  test("ignores chunk with same sequence (idempotent / no overwrite)", () => {
    const result = applyTextChunkOrdered(state("Hello world", 1), event(1, "Hello"));
    expect(result.liveText).toBe("Hello world");
    expect(result.lastAppliedSequence).toBe(1);
  });

  test("out-of-order delivery: newer then older does not overwrite with older", () => {
    let s = state("", -1);
    s = applyTextChunkOrdered(s, event(2, "Hel"));
    s = applyTextChunkOrdered(s, event(1, "H"));
    s = applyTextChunkOrdered(s, event(3, "Hello"));
    expect(s.liveText).toBe("Hello");
    expect(s.lastAppliedSequence).toBe(3);
  });

  test("in-order delivery produces correct final text", () => {
    let s = state("", -1);
    s = applyTextChunkOrdered(s, event(0, "H"));
    s = applyTextChunkOrdered(s, event(1, "He"));
    s = applyTextChunkOrdered(s, event(2, "Hel"));
    s = applyTextChunkOrdered(s, event(3, "Hell"));
    s = applyTextChunkOrdered(s, event(4, "Hello"));
    expect(s.liveText).toBe("Hello");
    expect(s.lastAppliedSequence).toBe(4);
  });

  test("bounds liveText to the latest 1M characters", () => {
    const bigText = "x".repeat(MAX_LIVE_TEXT_CHARS + 37);
    const result = applyTextChunkOrdered(state("", -1), event(0, bigText));
    expect(result.liveText.length).toBe(MAX_LIVE_TEXT_CHARS);
    expect(result.liveText).toBe(bigText.slice(-MAX_LIVE_TEXT_CHARS));
  });
});

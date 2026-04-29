import { describe, expect, test } from "bun:test";
import {
  initialScrollbackState,
  reduceScrollback,
  type OutputEntryWithId,
} from "./terminal-output-adapter";

function entry(id: string, message: string): OutputEntryWithId {
  return { id, type: "log", message, timestamp: new Date() };
}

describe("scrollback reducer", () => {
  test("appendStatic adds to staticEntries in order", () => {
    let state = initialScrollbackState();
    const a1 = entry("1", "first");
    const a2 = entry("2", "second");
    state = reduceScrollback(state, { type: "appendStatic", entries: [a1] });
    state = reduceScrollback(state, { type: "appendStatic", entries: [a2] });
    expect(state.staticEntries).toEqual([a1, a2]);
    expect(state.pending).toBeNull();
  });

  test("appendStatic with empty entries returns the same state instance", () => {
    const state = initialScrollbackState();
    const next = reduceScrollback(state, { type: "appendStatic", entries: [] });
    expect(next).toBe(state);
  });

  test("appendStream opens a pending of the requested kind", () => {
    let state = initialScrollbackState();
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: "hello ",
      nextId: "p1",
    });
    expect(state.pending).not.toBeNull();
    expect(state.pending!.kind).toBe("response");
    expect(state.pending!.rawTail).toBe("hello ");
    expect(state.staticEntries.length).toBe(0);
  });

  test("same-kind appends concatenate raw tail", () => {
    let state = initialScrollbackState();
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: "hello ",
      nextId: "p1",
    });
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: "world",
      nextId: "p2",
    });
    expect(state.pending!.rawTail).toBe("hello world");
    // ID shouldn't change while the same pending is active.
    expect(state.pending!.id).toBe("p1");
  });

  test("kind change finalizes prior pending and opens new", () => {
    let state = initialScrollbackState();
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "reasoning",
      delta: "thinking…",
      nextId: "p1",
    });
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: "answer",
      nextId: "p2",
      finalizeId: "p1-finalized",
    });
    // Prior pending finalized into Static as one streamContent entry.
    expect(state.staticEntries.length).toBe(1);
    expect(state.staticEntries[0]!.type).toBe("streamContent");
    expect(state.staticEntries[0]!.message).toContain("thinking");
    expect(state.staticEntries[0]!.id).toBe("p1-finalized");
    expect(state.staticEntries[0]!.meta).toEqual({ kind: "reasoning" });
    // New pending is open with the response kind.
    expect(state.pending!.kind).toBe("response");
    expect(state.pending!.rawTail).toBe("answer");
  });

  test("finalizeStream empties pending and appends one streamContent to Static", () => {
    let state = initialScrollbackState();
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: "complete answer",
      nextId: "p1",
    });
    state = reduceScrollback(state, { type: "finalizeStream", finalizeId: "p1-final" });
    expect(state.pending).toBeNull();
    expect(state.staticEntries.length).toBe(1);
    expect(state.staticEntries[0]!.type).toBe("streamContent");
    expect(state.staticEntries[0]!.message).toContain("complete answer");
    expect(state.staticEntries[0]!.id).toBe("p1-final");
    expect(state.staticEntries[0]!.meta).toEqual({ kind: "response" });
  });

  test("finalizeStream on null pending is a no-op", () => {
    const state = initialScrollbackState();
    const next = reduceScrollback(state, { type: "finalizeStream" });
    expect(next).toBe(state);
  });

  test("clear empties both arrays and bumps staticGeneration", () => {
    let state = initialScrollbackState();
    state = reduceScrollback(state, { type: "appendStatic", entries: [entry("1", "x")] });
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: "y",
      nextId: "p1",
    });
    const before = state.staticGeneration;
    state = reduceScrollback(state, { type: "clear" });
    expect(state.staticEntries).toEqual([]);
    expect(state.pending).toBeNull();
    expect(state.staticGeneration).toBe(before + 1);
  });

  test("appendStream with split-and-promote moves settled prefix to Static", () => {
    let state = initialScrollbackState();
    // Make a chunk large enough to escape SOFT_TAIL with a paragraph break inside.
    const chunk = "Settled paragraph one.\n\n" + "x".repeat(500); // far exceeds SOFT_TAIL=256
    state = reduceScrollback(state, {
      type: "appendStream",
      kind: "response",
      delta: chunk,
      nextId: "p1",
    });
    // The settled prefix should be in Static (one streamContent).
    expect(state.staticEntries.length).toBe(1);
    expect(state.staticEntries[0]!.message).toContain("Settled paragraph one");
    // The pending tail keeps the in-flight chunk.
    expect(state.pending).not.toBeNull();
    expect(state.pending!.rawTail.startsWith("xxx")).toBe(true);
  });

  test("regression guard: 1000 same-kind chunks produce O(paragraphs) Static entries", () => {
    let state = initialScrollbackState();
    for (let i = 0; i < 1000; i++) {
      state = reduceScrollback(state, {
        type: "appendStream",
        kind: "response",
        delta: `paragraph ${i} body text. ` + "y".repeat(50) + "\n\n",
        nextId: `p${i}`,
      });
    }
    state = reduceScrollback(state, { type: "finalizeStream", finalizeId: "final" });
    // Each chunk's \n\n eventually becomes a paragraph promotion. After
    // SOFT_TAIL (256 chars / ~3-4 chunks) of warm-up, every subsequent chunk
    // contributes a promotion. Final finalizeStream adds one more for the tail.
    // Expect roughly 990–1001 entries — at least 500 to confirm the splitter
    // is actively running (not promoting once and then stalling).
    expect(state.staticEntries.length).toBeGreaterThanOrEqual(500);
    expect(state.staticEntries.length).toBeLessThanOrEqual(1001);
    expect(state.pending).toBeNull();
  });
});

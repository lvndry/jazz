import { describe, expect, it } from "bun:test";
import { contentFromOutput } from "./document";
import { UIStore } from "./store";
import {
  addThoughtStep,
  foldedThoughtLine,
  NO_THOUGHT,
  thoughtLabel,
  thoughtText,
} from "./turn-thought";

describe("a turn's thinking, folded", () => {
  it("adds durations and steps, and keeps only the steps that returned text", () => {
    let thought = addThoughtStep(NO_THOUGHT, { durationMs: 1_500, text: "first" });
    thought = addThoughtStep(thought, { durationMs: 2_600 });
    thought = addThoughtStep(thought, { durationMs: 5_500, text: "third" });
    expect([thought.steps, thought.durationMs]).toEqual([3, 9_600]);
    expect(thoughtText(thought)).toBe("first\n\nthird");
  });

  it("names the duration, and the steps once there is more than one", () => {
    expect(thoughtLabel({ durationMs: 4_100, steps: 1 })).toBe("thought for 4.1s");
    expect(thoughtLabel({ durationMs: 9_600, steps: 5 })).toBe("thought for 9.6s across 5 steps");
  });

  it("offers ctrl+r only when there is text to read", () => {
    expect(foldedThoughtLine({ durationMs: 4_100 }, true, "›", " · ")).toBe(
      "› thought for 4.1s · ctrl+r to read",
    );
    expect(foldedThoughtLine({ durationMs: 4_100 }, false, "›", " · ")).toBe("› thought for 4.1s");
  });
});

describe("the store prints one thought line per turn", () => {
  const thinkFor = (store: UIStore, durationMs: number, text: string): void => {
    const region = store.openEphemeral("reasoning", "Reasoning", 8);
    store.collapseEphemeral(region, { durationMs, fullText: text });
  };
  const thoughtEntries = (store: UIStore) =>
    store
      .getOutputSnapshot()
      .entries.filter((entry) => contentFromOutput(entry).kind === "reasoning");

  it("holds each step until the turn settles, then prints them as one line", () => {
    const store = new UIStore();
    thinkFor(store, 1_500, "weighing the calendars");
    thinkFor(store, 2_600, "ranking the threads");
    store.flushOutputBatchNow();
    expect(thoughtEntries(store)).toHaveLength(0);

    store.settleTurnThought();
    const entries = thoughtEntries(store);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toMatchObject({
      kind: "reasoning",
      durationMs: 4100,
      steps: 2,
      text: "weighing the calendars\n\nranking the threads",
    });
  });

  it("makes the whole turn the block ctrl+r opens", () => {
    const store = new UIStore();
    thinkFor(store, 1_000, "one");
    thinkFor(store, 1_000, "two");
    store.settleTurnThought();
    expect(store.expandLastReasoning("append")).toBe(true);
    const opened = thoughtEntries(store).at(-1);
    expect(opened).toBeDefined();
    expect(store.isReasoningExpanded(opened!.id)).toBe(true);
    expect(opened?.message).toMatchObject({ kind: "reasoning", text: "one\n\ntwo" });
    expect(store.getDocumentSnapshot().entries).toHaveLength(2);
  });

  it("prints nothing for a turn that did not think", () => {
    const store = new UIStore();
    store.settleTurnThought();
    expect(thoughtEntries(store)).toHaveLength(0);
  });

  it("settles what the turn thought when it is interrupted", () => {
    const store = new UIStore();
    thinkFor(store, 1_000, "one");
    const open = store.openEphemeral("reasoning", "Reasoning", 8);
    store.appendEphemeral(open, "cut off mid-thought");
    store.openEphemeral("reasoning", "Reasoning", 8);
    store.collapseAllEphemeral();
    const entries = thoughtEntries(store);
    expect(entries).toHaveLength(1);
    // The region cut off before it said anything adds no step.
    expect(entries[0]?.message).toMatchObject({ steps: 2 });
  });
});

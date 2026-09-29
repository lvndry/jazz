import { describe, expect, test } from "bun:test";
import { UIStore } from "./store";

/** Everything streamed so far, settled and still pending, in order. */
function streamedText(store: UIStore): string {
  const snapshot = store.getOutputSnapshot();
  const settled = snapshot.entries
    .filter((entry) => entry.type === "streamContent")
    .map((entry) => String(entry.message))
    .join("");
  return settled + snapshot.streaming;
}

const BURST = "a paragraph the provider sent in one chunk ".repeat(8);

describe("paced streaming in the store", () => {
  test("holds a burst back while pacing, and shows it whole once finalized", () => {
    const store = new UIStore();
    store.setStreamPacing(true);
    store.appendStream("response", BURST);
    expect(streamedText(store).length).toBeLessThan(BURST.length);
    store.finalizeStream();
    expect(streamedText(store)).toBe(BURST);
    store.setStreamPacing(false);
  });

  test("lands paced text before an entry printed after it", () => {
    const store = new UIStore();
    store.setStreamPacing(true);
    store.appendStream("response", "Checking your calendar now. ");
    store.printOutput({ type: "info", message: "tool receipt", timestamp: new Date() });
    store.flushOutputBatchNow();
    expect(streamedText(store)).toBe("Checking your calendar now. ");
    store.finalizeStream();
    const entries = store.getOutputSnapshot().entries;
    const receipt = entries.findIndex((entry) => entry.message === "tool receipt");
    expect(receipt).toBeGreaterThan(-1);
    store.setStreamPacing(false);
  });

  test("shows everything at once while the reader is away from the live edge", () => {
    const store = new UIStore();
    store.setStreamPacing(true);
    store.setReaderFollowing(false);
    store.appendStream("response", BURST);
    expect(streamedText(store)).toBe(BURST);
    store.setStreamPacing(false);
  });

  test("passes every delta straight through when pacing is off, as for a screen reader", () => {
    const store = new UIStore();
    store.appendStream("response", BURST);
    expect(streamedText(store)).toBe(BURST);
  });
});

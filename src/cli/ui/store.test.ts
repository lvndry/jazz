import { describe, expect, test } from "bun:test";
import { UIStore } from "./store";
import type { OutputEntry } from "./types";

function entry(message = "hello"): OutputEntry {
  return { type: "log", message, timestamp: new Date() };
}

describe("UIStore", () => {
  // -------------------------------------------------------------------------
  // Pending queue — before handler registration
  // -------------------------------------------------------------------------

  describe("pending output queue", () => {
    test("queues entries when no handler is registered", () => {
      const s = new UIStore();
      s.printOutput(entry("a"));
      s.printOutput(entry("b"));

      const drained = s.drainPendingOutputQueue();
      expect(drained).toHaveLength(2);
      expect(drained[0]!.message).toBe("a");
      expect(drained[1]!.message).toBe("b");
    });

    test("assigns unique ids to queued entries", () => {
      const s = new UIStore();
      const id1 = s.printOutput(entry("a"));
      const id2 = s.printOutput(entry("b"));

      expect(id1).not.toBe(id2);
      expect(id1).toContain("queued-output-");
      expect(id2).toContain("queued-output-");
    });

    test("preserves caller-provided id", () => {
      const s = new UIStore();
      const id = s.printOutput({ ...entry(), id: "custom-id" });

      expect(id).toBe("custom-id");
      const drained = s.drainPendingOutputQueue();
      expect(drained[0]!.id).toBe("custom-id");
    });

    test("drops entries beyond MAX_PENDING_OUTPUT_QUEUE (2000)", () => {
      const s = new UIStore();
      for (let i = 0; i < 2050; i++) {
        s.printOutput(entry(`msg-${i}`));
      }

      const drained = s.drainPendingOutputQueue();
      expect(drained).toHaveLength(2000);
      // First entry is preserved, overflow entries are dropped
      expect(drained[0]!.message).toBe("msg-0");
      expect(drained[1999]!.message).toBe("msg-1999");
    });

    test("drain empties the queue", () => {
      const s = new UIStore();
      s.printOutput(entry("a"));

      const first = s.drainPendingOutputQueue();
      expect(first).toHaveLength(1);

      const second = s.drainPendingOutputQueue();
      expect(second).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Handler registration — entries bypass queue
  // -------------------------------------------------------------------------

  describe("handler registration", () => {
    test("delegates to handler once registered (batched on microtask)", async () => {
      const s = new UIStore();
      const received: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        received.push(...arr);
        return arr[0]?.id ?? "generated";
      });

      s.printOutput(entry("direct"));
      await Promise.resolve(); // Let batch microtask run
      expect(received).toHaveLength(1);
      expect(received[0]!.message).toBe("direct");
      expect(s.drainPendingOutputQueue()).toHaveLength(0);
    });

    test("coalesces rapid calls into single batch", async () => {
      const s = new UIStore();
      const received: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        received.push(...arr);
        return arr[0]?.id ?? "generated";
      });

      s.printOutput(entry("a"));
      s.printOutput(entry("b"));
      s.printOutput(entry("c"));
      expect(received).toHaveLength(0); // Not yet flushed
      await Promise.resolve();
      expect(received).toHaveLength(3);
      expect(received[0]!.message).toBe("a");
      expect(received[1]!.message).toBe("b");
      expect(received[2]!.message).toBe("c");
    });
  });

  // -------------------------------------------------------------------------
  // clearOutputs
  // -------------------------------------------------------------------------

  describe("clearOutputs", () => {
    test("sets pending clear flag and empties queue when no handler", () => {
      const s = new UIStore();
      s.printOutput(entry("a"));
      s.printOutput(entry("b"));

      s.clearOutputs();

      expect(s.hasPendingClear()).toBe(true);
      expect(s.drainPendingOutputQueue()).toHaveLength(0);
    });

    test("delegates to handler when registered", () => {
      const s = new UIStore();
      let cleared = false;
      s.registerClearOutputs(() => {
        cleared = true;
      });

      s.clearOutputs();

      expect(cleared).toBe(true);
      // No pending clear since handler was called directly
      expect(s.hasPendingClear()).toBe(false);
    });

    test("consumePendingClear resets the flag", () => {
      const s = new UIStore();
      s.clearOutputs();
      expect(s.hasPendingClear()).toBe(true);

      s.consumePendingClear();
      expect(s.hasPendingClear()).toBe(false);
    });

    test("discards pending batched outputs to prevent post-clear race", async () => {
      const s = new UIStore();
      const received: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        received.push(...arr);
        return arr[0]?.id ?? "generated";
      });
      s.registerClearOutputs(() => {
        received.length = 0;
      });

      s.printOutput(entry("a"));
      s.printOutput(entry("b"));
      // Before microtask flushes, clear outputs
      s.clearOutputs();

      // Let the microtask run - should NOT flush the discarded batch
      await Promise.resolve();
      expect(received).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Activity snapshots
  // -------------------------------------------------------------------------

  describe("activity snapshots", () => {
    test("stores and returns activity snapshot", () => {
      const s = new UIStore();
      expect(s.getActivitySnapshot()).toEqual({ phase: "idle" });

      s.setActivity({ phase: "thinking", agentName: "A", reasoning: "" });
      expect(s.getActivitySnapshot()).toEqual({ phase: "thinking", agentName: "A", reasoning: "" });
    });

    test("forwards activity to registered setter", () => {
      const s = new UIStore();
      const calls: unknown[] = [];
      s.registerActivitySetter((a) => calls.push(a));

      s.setActivity({ phase: "thinking", agentName: "A", reasoning: "" });
      expect(calls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Expandable diff
  // -------------------------------------------------------------------------

  describe("expandable diff", () => {
    test("returns null when no diff is set", () => {
      const s = new UIStore();
      expect(s.getExpandableDiff()).toBeNull();
    });

    test("stores and retrieves diff", () => {
      const s = new UIStore();
      s.setExpandableDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new");

      const payload = s.getExpandableDiff();
      expect(payload).not.toBeNull();
      expect(payload!.fullDiff).toBe("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new");
      expect(payload!.timestamp).toBeGreaterThan(0);
    });

    test("clear resets to null", () => {
      const s = new UIStore();
      s.setExpandableDiff("diff content");
      expect(s.getExpandableDiff()).not.toBeNull();

      s.clearExpandableDiff();
      expect(s.getExpandableDiff()).toBeNull();
    });
  });

  describe("interrupt handler stack", () => {
    test("nested setInterruptHandler restores outer handler when inner pops", () => {
      const s = new UIStore();
      const seen: Array<(() => void) | null> = [];
      s.registerInterruptHandler((h) => seen.push(h));

      const outer = (): void => {};
      const inner = (): void => {};

      s.setInterruptHandler(outer);
      s.setInterruptHandler(inner);
      s.setInterruptHandler(null);

      const top = seen[seen.length - 1];
      expect(top).toBe(outer);
    });

    test("popping below empty is a no-op (over-pop tolerated)", () => {
      const s = new UIStore();
      s.registerInterruptHandler(() => {});
      expect(() => s.setInterruptHandler(null)).not.toThrow();
    });

    test("registerInterruptHandler(null) detaches the UI setter without dropping the stack", () => {
      const s = new UIStore();
      const seenA: Array<(() => void) | null> = [];
      s.registerInterruptHandler((h) => seenA.push(h));

      const handler = (): void => {};
      s.setInterruptHandler(handler);

      s.registerInterruptHandler(null);
      // Re-attaching a fresh setter should observe the still-present handler.
      const seenB: Array<(() => void) | null> = [];
      s.registerInterruptHandler((h) => seenB.push(h));
      expect(seenB[0]).toBe(handler);
    });
  });

  // -------------------------------------------------------------------------
  // Message queue (chat busy-mode buffering)
  // -------------------------------------------------------------------------

  describe("message queue", () => {
    test("appendToQueue stores each entry as its own array element", () => {
      const s = new UIStore();
      s.appendToQueue("first");
      s.appendToQueue("second");
      s.appendToQueue("third");

      expect(s.getMessageQueueSnapshot()).toEqual(["first", "second", "third"]);
    });

    test("peekQueue joins entries with newlines for back-compat with the chat-loop drain", () => {
      const s = new UIStore();
      s.appendToQueue("first");
      s.appendToQueue("second");

      expect(s.peekQueue()).toBe("first\nsecond");
    });

    test("appendToQueue with empty string is a no-op", () => {
      const s = new UIStore();
      s.appendToQueue("only");
      s.appendToQueue("");

      expect(s.getMessageQueueSnapshot()).toEqual(["only"]);
    });

    test("takeQueue returns the joined string and clears the array", () => {
      const s = new UIStore();
      s.appendToQueue("hello");
      s.appendToQueue("world");

      expect(s.takeQueue()).toBe("hello\nworld");
      expect(s.getMessageQueueSnapshot()).toEqual([]);
    });

    test("takeQueue on empty queue returns empty string", () => {
      const s = new UIStore();
      expect(s.takeQueue()).toBe("");
    });

    test("clearQueue empties the array", () => {
      const s = new UIStore();
      s.appendToQueue("a");
      s.appendToQueue("b");
      s.clearQueue();

      expect(s.getMessageQueueSnapshot()).toEqual([]);
    });

    test("setter receives the array on append, clear, and take", () => {
      const s = new UIStore();
      // Mutable array of immutable snapshots — we accumulate snapshots,
      // never mutate them in place.
      const seen: (readonly string[])[] = [];
      s.registerMessageQueueSetter((q) => {
        seen.push([...q]);
      });

      s.appendToQueue("a");
      s.appendToQueue("b");
      s.takeQueue();
      s.appendToQueue("c");
      s.clearQueue();

      // First call is the hydration on register (empty array), then each mutation.
      expect(seen).toEqual([[], ["a"], ["a", "b"], [], ["c"], []]);
    });

    test("clearQueue when already empty does not notify setter", () => {
      const s = new UIStore();
      const seen: (readonly string[])[] = [];
      s.registerMessageQueueSetter((q) => seen.push(q));
      seen.length = 0; // discard hydration call

      s.clearQueue();
      expect(seen).toEqual([]);
    });

    test("snapshot accessor stays in sync", () => {
      const s = new UIStore();
      s.appendToQueue("x");
      expect(s.getMessageQueueSnapshot()).toEqual(["x"]);
      s.takeQueue();
      expect(s.getMessageQueueSnapshot()).toEqual([]);
    });
  });

  describe("chatBusy", () => {
    test("setChatBusy toggles snapshot", () => {
      const s = new UIStore();
      expect(s.getChatBusySnapshot()).toBe(false);
      s.setChatBusy(true);
      expect(s.getChatBusySnapshot()).toBe(true);
      s.setChatBusy(false);
      expect(s.getChatBusySnapshot()).toBe(false);
    });

    test("setter is notified on change but not on no-op", () => {
      const s = new UIStore();
      const seen: boolean[] = [];
      s.registerChatBusySetter((b) => seen.push(b));
      seen.length = 0; // discard hydration

      s.setChatBusy(true);
      s.setChatBusy(true); // no-op
      s.setChatBusy(false);
      s.setChatBusy(false); // no-op

      expect(seen).toEqual([true, false]);
    });
  });
});

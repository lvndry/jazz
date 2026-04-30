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
  // Ephemeral live regions
  // -------------------------------------------------------------------------

  describe("ephemeral regions", () => {
    test("openEphemeral returns unique ids and adds to snapshot", () => {
      const s = new UIStore();
      const a = s.openEphemeral("reasoning", "Reasoning", 8);
      const b = s.openEphemeral("subagent", "Sub-Agent (researcher)", 12);

      expect(a).not.toBe(b);
      const regions = s.getEphemeralRegionsSnapshot();
      expect(regions).toHaveLength(2);
      expect(regions[0]!.id).toBe(a);
      expect(regions[0]!.kind).toBe("reasoning");
      expect(regions[1]!.id).toBe(b);
      expect(regions[1]!.kind).toBe("subagent");
    });

    test("appendEphemeral splits, merges first chunk, trims to last N lines", () => {
      const s = new UIStore();
      const id = s.openEphemeral("reasoning", "Reasoning", 3);

      s.appendEphemeral(id, "first ");
      s.appendEphemeral(id, "line\nsecond\n");
      s.appendEphemeral(id, "third\nfourth\nfifth");

      const region = s.getEphemeralRegionsSnapshot()[0]!;
      // Expected lines after merge+split:
      //   "first line", "second", "", "third", "fourth", "fifth"
      // Hmm — "second\n" leaves a trailing empty. Then "third" appends to that
      // empty as the first chunk merge. So actual sequence:
      //   ["first line", "second", "third", "fourth", "fifth"]
      // Trimmed to last 3:
      //   ["third", "fourth", "fifth"]
      expect(region.tail).toEqual(["third", "fourth", "fifth"]);
    });

    test("appendEphemeral targets only the specified region", () => {
      const s = new UIStore();
      const a = s.openEphemeral("reasoning", "Reasoning", 8);
      const b = s.openEphemeral("subagent", "Sub", 8);

      s.appendEphemeral(a, "hello");
      s.appendEphemeral(b, "world");

      const regions = s.getEphemeralRegionsSnapshot();
      expect(regions[0]!.tail).toEqual(["hello"]);
      expect(regions[1]!.tail).toEqual(["world"]);
    });

    test("collapseEphemeral removes region and emits summary line", () => {
      const s = new UIStore();
      const received: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        received.push(...arr);
        return arr[0]?.id ?? "id";
      });

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, {
        line: "✓ Reasoning · 12s · 100 tokens",
        durationMs: 12000,
      });

      expect(s.getEphemeralRegionsSnapshot()).toHaveLength(0);
      // Wait for batch microtask
      return Promise.resolve().then(() => {
        expect(received).toHaveLength(1);
        expect(received[0]!.message).toBe("✓ Reasoning · 12s · 100 tokens");
      });
    });

    test("collapseEphemeral with reasoning + fullText populates expandableReasoning", () => {
      const s = new UIStore();
      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, {
        durationMs: 5000,
        tokens: 42,
        fullText: "I was thinking about X then Y",
      });

      const expandable = s.getExpandableReasoningSnapshot();
      expect(expandable).not.toBeNull();
      expect(expandable!.fullText).toBe("I was thinking about X then Y");
      expect(expandable!.durationMs).toBe(5000);
      expect(expandable!.tokens).toBe(42);
    });

    test("subagent collapse does NOT populate expandableReasoning", () => {
      const s = new UIStore();
      const id = s.openEphemeral("subagent", "Sub-Agent", 12);
      s.collapseEphemeral(id, {
        durationMs: 1000,
        fullText: "subagent body — should be ignored for expand",
      });

      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("collapseAllEphemeral removes every open region without emitting summaries", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });

      s.openEphemeral("reasoning", "R", 8);
      s.openEphemeral("subagent", "S1", 12);
      s.openEphemeral("subagent", "S2", 12);

      s.collapseAllEphemeral();

      expect(s.getEphemeralRegionsSnapshot()).toHaveLength(0);
      return Promise.resolve().then(() => {
        expect(printed).toHaveLength(0);
      });
    });

    test("expandLastReasoning emits full text once and clears the slot", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, {
        durationMs: 1000,
        fullText: "full reasoning body",
      });

      s.expandLastReasoning();
      s.expandLastReasoning(); // second call is no-op

      return Promise.resolve().then(() => {
        expect(printed).toHaveLength(1);
        expect(printed[0]!.type).toBe("streamContent");
        expect(printed[0]!.message).toBe("full reasoning body");
        expect(s.getExpandableReasoningSnapshot()).toBeNull();
      });
    });

    test("setter is notified on open, append, and collapse", () => {
      const s = new UIStore();
      const seen: number[] = [];
      s.registerEphemeralRegionsSetter((regions) => seen.push(regions.length));
      seen.length = 0;

      const id = s.openEphemeral("reasoning", "R", 8);
      s.appendEphemeral(id, "x");
      s.collapseEphemeral(id, { durationMs: 1, line: "✓ R" });

      expect(seen).toEqual([1, 1, 0]);
    });
  });
});

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
    test("delegates to handler once registered", () => {
      const s = new UIStore();
      const received: OutputEntry[] = [];
      s.registerPrintOutput((e) => {
        received.push(e);
        return e.id ?? "generated";
      });

      s.printOutput(entry("direct"));
      expect(received).toHaveLength(1);
      expect(received[0]!.message).toBe("direct");
      // Nothing in pending queue
      expect(s.drainPendingOutputQueue()).toHaveLength(0);
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
      s.registerClearOutputs(() => { cleared = true; });

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
});

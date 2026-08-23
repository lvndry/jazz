import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { UIStore, type ActiveMenu } from "./store";
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

    test("stale renderer cleanup does not unregister a newer fallback handler", () => {
      const s = new UIStore();
      let fallbackRequests = 0;
      const unregisterFirst = s.registerRendererFallbackHandler(() => {
        fallbackRequests += 100;
      });
      const unregisterSecond = s.registerRendererFallbackHandler(() => {
        fallbackRequests += 1;
      });

      unregisterFirst();
      s.requestRendererFallback();
      expect(fallbackRequests).toBe(1);

      unregisterSecond();
      s.requestRendererFallback();
      expect(fallbackRequests).toBe(1);
    });

    test("carries a data-only menu across renderer replacement", () => {
      const s = new UIStore();
      const firstRenderer: Array<ActiveMenu | null> = [];
      const secondRenderer: Array<ActiveMenu | null> = [];
      const menu: ActiveMenu = {
        kind: "menu",
        options: [{ label: "Start chatting", value: "chat" }],
      };
      s.registerActiveMenuSetter((next) => firstRenderer.push(next));

      s.setActiveMenu(menu);
      s.registerActiveMenuSetter((next) => secondRenderer.push(next));
      s.setActiveMenu(null);

      expect(firstRenderer).toEqual([null, menu]);
      expect(secondRenderer).toEqual([menu, null]);
    });
  });

  describe("completePrompt", () => {
    test("does not expose setCustomView", () => {
      const s = new UIStore();
      expect("setCustomView" in s).toBe(false);
      expect("registerCustomView" in s).toBe(false);
    });

    test("no producer or renderer still calls setCustomView", () => {
      const sources = [
        join(import.meta.dir, "store.ts"),
        join(import.meta.dir, "App.tsx"),
        join(import.meta.dir, "fullscreen/bridge.tsx"),
        join(import.meta.dir, "../commands/wizard.ts"),
        join(import.meta.dir, "../commands/config-wizard.ts"),
        join(import.meta.dir, "../commands/workflow.ts"),
      ];
      for (const sourcePath of sources) {
        const source = readFileSync(sourcePath, "utf8");
        expect(source.includes("setCustomView")).toBe(false);
        expect(source.includes("registerCustomView")).toBe(false);
      }
    });

    test("keeps the snapshot data-only and runs the continuation once", () => {
      const s = new UIStore();
      const results: string[] = [];
      s.setActiveMenu(
        {
          kind: "menu",
          options: [{ label: "Start chatting", value: "chat" }],
        },
        (result) => results.push(result.kind === "exit" ? "exit" : result.value),
      );

      const snapshot = s.getActiveMenuSnapshot();
      expect(snapshot).not.toHaveProperty("onSelect");
      expect(snapshot).not.toHaveProperty("onExit");
      if (snapshot !== null) {
        for (const value of Object.values(snapshot)) {
          expect(typeof value).not.toBe("function");
        }
      }

      s.completePrompt({ kind: "select", value: "chat" });
      s.completePrompt({ kind: "select", value: "again" });
      expect(results).toEqual(["chat"]);
      expect(s.getActiveMenuSnapshot()).toBe(null);
    });

    test("drops a pending continuation when the menu is cleared", () => {
      const s = new UIStore();
      let called = 0;
      s.setActiveMenu({ kind: "menu", options: [{ label: "Go", value: "go" }] }, () => {
        called += 1;
      });
      s.setActiveMenu(null);
      s.completePrompt({ kind: "exit" });
      expect(called).toBe(0);
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

      s.setActivity({ phase: "thinking", agentName: "A" });
      expect(s.getActivitySnapshot()).toEqual({ phase: "thinking", agentName: "A" });
    });

    test("forwards activity to registered setter", () => {
      const s = new UIStore();
      const calls: unknown[] = [];
      s.registerActivitySetter((a) => calls.push(a));

      s.setActivity({ phase: "thinking", agentName: "A" });
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

    test("collapseEphemeral keeps the live tail when fullText is missing", () => {
      const s = new UIStore();
      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.appendEphemeral(id, "kept from the live panel");
      s.collapseEphemeral(id, { durationMs: 800 });

      expect(s.getExpandableReasoningSnapshot()?.fullText).toBe("kept from the live panel");
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

    test("expandLastReasoning rewrites the collapsed entry in place", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });
      s.registerUpdateOutput((id, patch) => {
        const index = printed.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        printed[index] = {
          ...printed[index]!,
          ...patch,
          meta: { ...printed[index]!.meta, ...patch.meta },
        };
      });

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, {
        durationMs: 1000,
        fullText: "full reasoning body",
      });

      expect(printed).toHaveLength(1);
      expect(printed[0]!.meta?.["collapsed"]).toBe(true);

      s.expandLastReasoning();
      s.expandLastReasoning(); // second call is no-op

      expect(printed).toHaveLength(1);
      expect(printed[0]!.type).toBe("streamContent");
      expect(printed[0]!.message).toContain("full reasoning body");
      expect(printed[0]!.message).toContain("Reasoning · 1.0s");
      expect(printed[0]!.meta?.["collapsed"]).toBe(false);
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("expandLastReasoning expands later blocks without moving them", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });
      s.registerUpdateOutput((id, patch) => {
        const index = printed.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        printed[index] = {
          ...printed[index]!,
          ...patch,
          meta: { ...printed[index]!.meta, ...patch.meta },
        };
      });

      const first = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(first, { durationMs: 500, fullText: "first block" });
      const second = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(second, { durationMs: 700, fullText: "second block" });

      s.expandLastReasoning();
      s.expandLastReasoning();
      s.expandLastReasoning(); // stack empty — no-op

      expect(printed).toHaveLength(2);
      expect(printed[0]!.message).toContain("first block");
      expect(printed[1]!.message).toContain("second block");
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("Ctrl+R during a live panel pins it so collapse stays expanded", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.appendEphemeral(id, "live thought");
      expect(s.expandLastReasoning()).toBe(true);
      s.collapseEphemeral(id, { durationMs: 400, fullText: "live thought" });

      expect(printed).toHaveLength(1);
      expect(printed[0]!.meta?.["collapsed"]).toBe(false);
      expect(printed[0]!.message).toContain("live thought");
    });

    test("setCollapseReasoning(false) settles reasoning expanded without Ctrl+R", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });
      s.setCollapseReasoning(false);

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, { durationMs: 1500, fullText: "the whole thought" });

      expect(printed).toHaveLength(1);
      expect(printed[0]!.meta?.["collapsed"]).toBe(false);
      expect(printed[0]!.message).toContain("the whole thought");
      expect(printed[0]!.message).not.toContain("ctrl+r");
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("setCollapseReasoning(false) dumps in-flight reasoning on collapseAllEphemeral", () => {
      const s = new UIStore();
      const printed: OutputEntry[] = [];
      s.registerPrintOutput((eOrBatch) => {
        const arr = Array.isArray(eOrBatch) ? eOrBatch : [eOrBatch];
        printed.push(...arr);
        return arr[0]?.id ?? "id";
      });
      s.setCollapseReasoning(false);

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.appendEphemeral(id, "interrupted thought");
      s.collapseAllEphemeral();

      expect(s.getEphemeralRegionsSnapshot()).toHaveLength(0);
      expect(printed).toHaveLength(1);
      expect(printed[0]!.meta?.["collapsed"]).toBe(false);
      expect(printed[0]!.message).toContain("interrupted thought");
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
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

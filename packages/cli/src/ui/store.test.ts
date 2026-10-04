/** Exercises UIStore's published snapshots, subscriptions, prompt lifecycle, and queued turns. */
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

  describe("output slice", () => {
    test("printOutput lands in the snapshot after the batch flush", async () => {
      const s = new UIStore();
      s.printOutput(entry("a"));
      s.printOutput(entry("b"));
      expect(s.getOutputSnapshot().entries).toHaveLength(0);

      await Promise.resolve();
      expect(s.getOutputSnapshot().entries).toHaveLength(2);
      expect(s.getOutputSnapshot().entries[0]!.message).toBe("a");
      expect(s.getOutputSnapshot().entries[1]!.message).toBe("b");
    });

    test("assigns unique ids to printed entries", () => {
      const s = new UIStore();
      const id1 = s.printOutput(entry("a"));
      const id2 = s.printOutput(entry("b"));

      expect(id1).not.toBe(id2);
      expect(id1).toContain("queued-output-");
      expect(id2).toContain("queued-output-");
    });

    test("preserves caller-provided id", async () => {
      const s = new UIStore();
      const id = s.printOutput({ ...entry(), id: "custom-id" });

      expect(id).toBe("custom-id");
      s.flushOutputBatchNow();
      expect(s.getOutputSnapshot().entries[0]!.id).toBe("custom-id");
    });
  });

  // -------------------------------------------------------------------------
  // Handler registration — entries bypass queue
  // -------------------------------------------------------------------------

  describe("subscribe slices", () => {
    test("publishes replacement generations coherently while stream revisions keep their lifetime", async () => {
      const s = new UIStore();
      const observed: Array<{ generation: number; documentId: string }> = [];
      s.subscribePresentation(() => {
        const snapshot = s.getPresentationSnapshot();
        observed.push({
          generation: snapshot.documentGeneration,
          documentId: snapshot.document.id,
        });
      });
      expect(s.getPresentationSnapshot().documentGeneration).toBe(0);
      s.replaceDocument("same-source-id", []);
      expect(observed.at(-1)).toEqual({ generation: 1, documentId: "same-source-id" });
      s.appendStream("response", "accepted text");
      await Promise.resolve();
      expect(s.getPresentationSnapshot().documentGeneration).toBe(1);
      s.finalizeStream();
      await Promise.resolve();
      expect(s.getPresentationSnapshot().documentGeneration).toBe(1);
      s.replaceDocument("same-source-id", []);
      expect(observed.at(-1)).toEqual({ generation: 2, documentId: "same-source-id" });
      s.clearOutputs();
      await Promise.resolve();
      expect(observed.at(-1)).toEqual({ generation: 3, documentId: "session:3" });
    });

    test("output subscribe is multicast — both trees see the same snapshot", async () => {
      const s = new UIStore();
      const ink: OutputEntry[][] = [];
      const fullscreen: OutputEntry[][] = [];
      s.subscribeOutput(() => ink.push([...s.getOutputSnapshot().entries]));
      s.subscribeOutput(() => fullscreen.push([...s.getOutputSnapshot().entries]));

      s.printOutput(entry("hello"));
      await Promise.resolve();

      expect(ink).toHaveLength(1);
      expect(fullscreen).toHaveLength(1);
      expect(ink[0]).toEqual(fullscreen[0]);
      expect(ink[0]![0]!.message).toBe("hello");
      expect(s.getOutputSnapshot()).toBe(s.getOutputSnapshot());
    });

    test("getSnapshot is Object.is-stable across reads and unrelated writes", () => {
      const s = new UIStore();
      const output = s.getOutputSnapshot();
      const session = s.getSessionSnapshot();
      const prompt = s.getPromptSlice();
      const ephemeral = s.getEphemeralSnapshot();

      expect(s.getOutputSnapshot()).toBe(output);
      expect(s.getSessionSnapshot()).toBe(session);
      expect(s.getPromptSlice()).toBe(prompt);
      expect(s.getEphemeralSnapshot()).toBe(ephemeral);

      s.setActivity({ phase: "thinking", agentName: "A" });
      expect(s.getOutputSnapshot()).toBe(output);
      expect(s.getPromptSlice()).toBe(prompt);
      expect(s.getEphemeralSnapshot()).toBe(ephemeral);
      expect(s.getSessionSnapshot()).not.toBe(session);
      expect(s.getSessionSnapshot()).toBe(s.getSessionSnapshot());
    });

    test("session subscribe is multicast", () => {
      const s = new UIStore();
      let ink = 0;
      let fullscreen = 0;
      s.subscribeSession(() => {
        ink += 1;
      });
      s.subscribeSession(() => {
        fullscreen += 1;
      });

      s.setChatBusy(true);
      expect(ink).toBe(1);
      expect(fullscreen).toBe(1);
      s.setChatBusy(true);
      expect(ink).toBe(1);
      expect(fullscreen).toBe(1);
    });

    test("unsubscribing one tree does not silence the other", async () => {
      const s = new UIStore();
      let ink = 0;
      let fullscreen = 0;
      const unsubscribeInk = s.subscribeOutput(() => {
        ink += 1;
      });
      s.subscribeOutput(() => {
        fullscreen += 1;
      });

      s.printOutput(entry("a"));
      s.flushOutputBatchNow();
      await Promise.resolve();
      unsubscribeInk();
      s.printOutput(entry("b"));
      s.flushOutputBatchNow();
      await Promise.resolve();

      expect(ink).toBe(1);
      expect(fullscreen).toBe(2);
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

    test("both session subscribers see a data-only menu", () => {
      const s = new UIStore();
      const ink: Array<ActiveMenu | null> = [];
      const fullscreen: Array<ActiveMenu | null> = [];
      const menu: ActiveMenu = {
        kind: "menu",
        options: [{ label: "Start chatting", value: "chat" }],
      };
      s.subscribeSession(() => ink.push(s.getActiveMenuSnapshot()));
      s.subscribeSession(() => fullscreen.push(s.getActiveMenuSnapshot()));

      s.setActiveMenu(menu);
      s.setActiveMenu(null);

      expect(ink).toEqual([menu, null]);
      expect(fullscreen).toEqual([menu, null]);
    });
  });

  describe("command panel", () => {
    const text = (message: string) => ({
      kind: "text" as const,
      tone: "info" as const,
      text: message,
    });

    test("opens on a run's first output, not when the run begins", () => {
      const s = new UIStore();
      const run = s.beginCommandPanel();
      expect(s.getCommandPanelSnapshot()).toBe(null);

      s.appendCommandPanel(run, "/info", text("one"));
      s.appendCommandPanel(run, "/info", text("two"));
      expect(s.getCommandPanelSnapshot()?.entries).toEqual([text("one"), text("two")]);
    });

    test("a newer run replaces the panel and an older run's late output is dropped", () => {
      const s = new UIStore();
      const older = s.beginCommandPanel();
      const newer = s.beginCommandPanel();
      s.appendCommandPanel(older, "/info", text("old"));
      s.appendCommandPanel(newer, "/cost", text("new"));
      s.appendCommandPanel(older, "/info", text("late"));

      expect(s.getCommandPanelSnapshot()).toEqual({
        id: newer,
        command: "/cost",
        entries: [text("new")],
      });
    });

    test("output after the panel was closed does not reopen it", () => {
      const s = new UIStore();
      const run = s.beginCommandPanel();
      s.appendCommandPanel(run, "/info", text("first"));
      s.closeCommandPanel();
      s.appendCommandPanel(run, "/info", text("second"));
      expect(s.getCommandPanelSnapshot()).toBe(null);
    });

    test("runs a command immediately only through the registered runner", () => {
      const s = new UIStore();
      expect(s.runCommandImmediately("/info")).toBe(false);
      const seen: string[] = [];
      s.registerImmediateCommandRunner((command) => (seen.push(command), true));
      expect(s.runCommandImmediately("  /info  ")).toBe(true);
      expect(seen).toEqual(["/info"]);
    });
  });

  describe("theme picker prompt", () => {
    test("a prompt the session needs dismisses the theme picker", () => {
      const s = new UIStore();
      let dismissed = 0;
      s.setPrompt({
        type: "theme",
        message: "Theme",
        resolve: () => undefined,
        reject: () => (dismissed += 1),
      });
      const question = { type: "chat" as const, message: "You:", resolve: () => undefined };
      s.setPrompt(question);
      expect(dismissed).toBe(1);
      expect(s.getPromptSnapshot()).toBe(question);
    });
  });

  describe("completePrompt", () => {
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
    test("clears the output snapshot immediately", () => {
      const s = new UIStore();
      s.printOutput(entry("a"));
      s.printOutput(entry("b"));
      s.flushOutputBatchNow();
      expect(s.getOutputSnapshot().entries).toHaveLength(2);

      s.clearOutputs();

      expect(s.getOutputSnapshot().entries).toHaveLength(0);
      expect(s.getOutputSnapshot().streaming).toBe("");
    });

    test("discards pending batched outputs to prevent post-clear race", async () => {
      const s = new UIStore();
      s.printOutput(entry("a"));
      s.printOutput(entry("b"));
      s.clearOutputs();

      await Promise.resolve();
      expect(s.getOutputSnapshot().entries).toHaveLength(0);
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

    test("notifies session subscribers", () => {
      const s = new UIStore();
      const calls: unknown[] = [];
      s.subscribeSession(() => calls.push(s.getActivitySnapshot()));

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
    test("nested handlers all receive an interrupt, and inner pop restores outer dispatch", () => {
      const s = new UIStore();
      const calls: string[] = [];
      const outer = (): void => void calls.push("outer");
      const inner = (): void => void calls.push("inner");

      s.setInterruptHandler(outer);
      s.setInterruptHandler(inner);
      s.getSessionSnapshot().interruptHandler?.();
      expect(calls).toEqual(["inner", "outer"]);

      calls.length = 0;
      s.setInterruptHandler(null);
      s.getSessionSnapshot().interruptHandler?.();
      expect(calls).toEqual(["outer"]);
    });

    test("popping below empty is a no-op (over-pop tolerated)", () => {
      const s = new UIStore();
      expect(() => s.setInterruptHandler(null)).not.toThrow();
    });

    test("unsubscribing does not drop the interrupt stack", () => {
      const s = new UIStore();
      const unsubscribe = s.subscribeSession(() => undefined);

      const handler = (): void => {};
      s.setInterruptHandler(handler);
      unsubscribe();

      expect(s.getSessionSnapshot().interruptHandler).not.toBeNull();
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

    test("collapseEphemeral removes the region, and the turn's line lands when it settles", () => {
      const s = new UIStore();

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, {
        line: "✓ Reasoning · 12s · 100 tokens",
        durationMs: 12000,
      });

      expect(s.getEphemeralRegionsSnapshot()).toHaveLength(0);
      s.flushOutputBatchNow();
      expect(s.getOutputSnapshot().entries).toHaveLength(0);
      s.settleTurnThought();
      expect(s.getOutputSnapshot().entries).toHaveLength(1);
      expect(s.getOutputSnapshot().entries[0]!.message).toMatchObject({
        kind: "reasoning",
        durationMs: 12000,
      });
    });

    test("collapseEphemeral keeps the live tail when fullText is missing", () => {
      const s = new UIStore();
      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.appendEphemeral(id, "kept from the live panel");
      s.collapseEphemeral(id, { durationMs: 800 });
      s.settleTurnThought();

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
      s.settleTurnThought();

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

      s.openEphemeral("reasoning", "R", 8);
      s.openEphemeral("subagent", "S1", 12);
      s.openEphemeral("subagent", "S2", 12);

      s.collapseAllEphemeral();

      expect(s.getEphemeralRegionsSnapshot()).toHaveLength(0);
      expect(s.getOutputSnapshot().entries).toHaveLength(0);
    });

    test("expandLastReasoning rewrites the collapsed entry in place", () => {
      const s = new UIStore();

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, {
        durationMs: 1000,
        fullText: "full reasoning body",
      });
      s.settleTurnThought();

      expect(s.getOutputSnapshot().entries).toHaveLength(1);
      expect(s.isReasoningExpanded(s.getOutputSnapshot().entries[0]!.id)).toBe(false);

      s.expandLastReasoning();
      s.expandLastReasoning(); // second call is no-op

      const printed = s.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(printed[0]!.type).toBe("streamContent");
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "full reasoning body" });
      expect(s.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("expandLastReasoning('append') adds a fresh entry so Ink's Static can show it", () => {
      const s = new UIStore();

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, { durationMs: 1000, fullText: "full reasoning body" });
      s.settleTurnThought();

      expect(s.getOutputSnapshot().entries).toHaveLength(1);

      s.expandLastReasoning("append");

      const printed = s.getOutputSnapshot().entries;
      expect(printed).toHaveLength(2);
      expect(s.isReasoningExpanded(printed[0]!.id)).toBe(false);
      expect(printed[1]!.message).toMatchObject({ kind: "reasoning", text: "full reasoning body" });
      expect(printed[1]!.id).not.toBe(printed[0]!.id);
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("expandLastReasoning expands earlier turns without moving them", () => {
      const s = new UIStore();

      const first = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(first, { durationMs: 500, fullText: "first block" });
      s.settleTurnThought();
      const second = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(second, { durationMs: 700, fullText: "second block" });
      s.settleTurnThought();

      s.expandLastReasoning();
      s.expandLastReasoning();
      s.expandLastReasoning(); // stack empty — no-op

      const printed = s.getOutputSnapshot().entries;
      expect(printed).toHaveLength(2);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "first block" });
      expect(printed[1]!.message).toMatchObject({ kind: "reasoning", text: "second block" });
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("Ctrl+R during a live panel pins it so collapse stays expanded", () => {
      const s = new UIStore();

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.appendEphemeral(id, "live thought");
      expect(s.expandLastReasoning()).toBe(true);
      s.collapseEphemeral(id, { durationMs: 400, fullText: "live thought" });

      const printed = s.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(s.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "live thought" });
    });

    test("setCollapseReasoning(false) settles reasoning expanded without Ctrl+R", () => {
      const s = new UIStore();
      s.setCollapseReasoning(false);

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.collapseEphemeral(id, { durationMs: 1500, fullText: "the whole thought" });

      const printed = s.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(s.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "the whole thought" });
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("setCollapseReasoning(false) dumps in-flight reasoning on collapseAllEphemeral", () => {
      const s = new UIStore();
      s.setCollapseReasoning(false);

      const id = s.openEphemeral("reasoning", "Reasoning", 8);
      s.appendEphemeral(id, "interrupted thought");
      s.collapseAllEphemeral();

      expect(s.getEphemeralRegionsSnapshot()).toHaveLength(0);
      const printed = s.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(s.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "interrupted thought" });
      expect(s.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("ephemeral subscribers are notified on open, append, and collapse", () => {
      const s = new UIStore();
      const seen: number[] = [];
      s.subscribeEphemeral(() => seen.push(s.getEphemeralSnapshot().regions.length));

      const id = s.openEphemeral("reasoning", "R", 8);
      s.appendEphemeral(id, "x");
      s.collapseEphemeral(id, { durationMs: 1, line: "✓ R" });

      expect(seen.slice(0, 3)).toEqual([1, 1, 0]);
      expect(seen.at(-1)).toBe(0);
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

    test("takeQueuedTurn pops a head command alone and leaves the rest queued", () => {
      const s = new UIStore();
      s.appendToQueue("/info");
      s.appendToQueue("keep going");
      s.appendToQueue("and this");

      expect(s.takeQueuedTurn()).toEqual(["/info"]);
      expect(s.getMessageQueueSnapshot()).toEqual(["keep going", "and this"]);
      expect(s.takeQueuedTurn()).toEqual(["keep going", "and this"]);
      expect(s.getMessageQueueSnapshot()).toEqual([]);
    });

    test("takeQueuedTurn stops a prose run at the next command", () => {
      const s = new UIStore();
      s.appendToQueue("first");
      s.appendToQueue("! git status");
      s.appendToQueue("last");

      expect(s.takeQueuedTurn()).toEqual(["first"]);
      expect(s.takeQueuedTurn()).toEqual(["! git status"]);
      expect(s.takeQueuedTurn()).toEqual(["last"]);
      expect(s.takeQueuedTurn()).toEqual([]);
    });

    test("takeQueuedProse never pops a command, so mid-run injection skips it", () => {
      const s = new UIStore();
      s.appendToQueue("/compact");
      s.appendToQueue("note");
      expect(s.takeQueuedProse()).toEqual([]);
      expect(s.getMessageQueueSnapshot()).toEqual(["/compact", "note"]);

      const t = new UIStore();
      t.appendToQueue("a");
      t.appendToQueue("/slash\nstill prose");
      t.appendToQueue("/help");
      expect(t.takeQueuedProse()).toEqual(["a", "/slash\nstill prose"]);
      expect(t.getMessageQueueSnapshot()).toEqual(["/help"]);
    });

    test("clearQueue empties the array", () => {
      const s = new UIStore();
      s.appendToQueue("a");
      s.appendToQueue("b");
      s.clearQueue();

      expect(s.getMessageQueueSnapshot()).toEqual([]);
    });

    test("prompt subscribers receive the queue on append, clear, and take", () => {
      const s = new UIStore();
      const seen: (readonly string[])[] = [];
      s.subscribePrompt(() => {
        seen.push([...s.getPromptSlice().messageQueue]);
      });

      s.appendToQueue("a");
      s.appendToQueue("b");
      s.takeQueue();
      s.appendToQueue("c");
      s.clearQueue();

      expect(seen).toEqual([["a"], ["a", "b"], [], ["c"], []]);
    });

    test("clearQueue when already empty does not notify subscribers", () => {
      const s = new UIStore();
      const seen: (readonly string[])[] = [];
      s.subscribePrompt(() => seen.push(s.getPromptSlice().messageQueue));

      s.clearQueue();
      expect(seen).toEqual([]);
    });

    test("requestFlushQueue/consumeFlushQueue is a one-shot flag", () => {
      const s = new UIStore();
      expect(s.consumeFlushQueue()).toBe(false);
      s.requestFlushQueue();
      expect(s.consumeFlushQueue()).toBe(true);
      expect(s.consumeFlushQueue()).toBe(false);
    });
  });

  describe("toggleLastReceiptOutput", () => {
    async function expandedIds(store: UIStore): Promise<ReadonlySet<string>> {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      return store.getPresentationSnapshot().expandedReceiptIds;
    }

    function commandReceipt(command: string, detail: string) {
      return {
        app: "execute_command",
        summary: "",
        status: "ok" as const,
        args: command,
        outputPreview: detail.split("\n")[0] ?? detail,
        detail,
      };
    }

    test("opens the newest receipt that has more output than its preview, and closes it again", async () => {
      const s = new UIStore();
      s.printContent({ kind: "tool", receipt: commandReceipt("git a", "one\ntwo") }, "tool-a");
      s.printContent({ kind: "tool", receipt: commandReceipt("git b", "three\nfour") }, "tool-b");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const [first, second] = s.getDocumentSnapshot().entries;

      expect(s.toggleLastReceiptOutput()).toBe(true);
      expect((await expandedIds(s)).has(second?.id ?? "")).toBe(true);
      expect((await expandedIds(s)).has(first?.id ?? "")).toBe(false);

      expect(s.toggleLastReceiptOutput()).toBe(true);
      expect((await expandedIds(s)).size).toBe(0);
    });

    test("reports nothing to expand when every receipt fits its preview", async () => {
      const s = new UIStore();
      s.printContent({ kind: "tool", receipt: commandReceipt("echo hi", "hi") }, "tool");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(s.toggleLastReceiptOutput()).toBe(false);
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

    test("a turn ending mid-retry does not bring its countdown back on the next send", () => {
      const s = new UIStore();
      s.setChatBusy(true);
      s.setRetryNotice({
        agentName: "agent",
        reason: "rate limit",
        detail: "",
        attempt: 7,
        maxAttempts: 10,
        retryInMs: 30_000,
        retryAt: Date.now() + 30_000,
      });
      s.setChatBusy(false);
      expect(s.getSessionSnapshot().retryNotice).toBeNull();

      s.setRetryNotice({
        agentName: "agent",
        reason: "rate limit",
        detail: "",
        attempt: 7,
        maxAttempts: 10,
        retryInMs: 30_000,
        retryAt: Date.now() + 30_000,
      });
      s.setChatBusy(true);
      expect(s.getSessionSnapshot().retryNotice).toBeNull();
    });

    test("session subscribers are notified on change but not on no-op", () => {
      const s = new UIStore();
      const seen: boolean[] = [];
      s.subscribeSession(() => seen.push(s.getChatBusySnapshot()));

      s.setChatBusy(true);
      s.setChatBusy(true); // no-op
      s.setChatBusy(false);
      s.setChatBusy(false); // no-op

      expect(seen).toEqual([true, false]);
    });
  });

  describe("session usage", () => {
    test("addSessionUsage accumulates billed prompt and completion tokens", () => {
      const sessionStore = new UIStore();
      sessionStore.addSessionUsage({ promptTokens: 20_000, completionTokens: 40_000 });
      sessionStore.addSessionUsage({ promptTokens: 1_000, completionTokens: 500 });

      expect(sessionStore.getRunStatsSnapshot()).toEqual({
        promptTokens: 21_000,
        completionTokens: 40_500,
      });
    });

    test("addSessionUsage ignores a zero delta", () => {
      const sessionStore = new UIStore();
      sessionStore.addSessionUsage({ promptTokens: 10, completionTokens: 5 });
      sessionStore.addSessionUsage({ promptTokens: 0, completionTokens: 0 });

      expect(sessionStore.getRunStatsSnapshot()).toEqual({
        promptTokens: 10,
        completionTokens: 5,
      });
    });

    test("resetRunStats clears accumulated usage", () => {
      const sessionStore = new UIStore();
      sessionStore.addSessionUsage({ promptTokens: 20_000, completionTokens: 40_000 });
      sessionStore.resetRunStats({ model: "opus-4" });

      expect(sessionStore.getRunStatsSnapshot()).toEqual({ model: "opus-4" });

      sessionStore.addSessionUsage({ promptTokens: 100, completionTokens: 50 });
      expect(sessionStore.getRunStatsSnapshot()).toEqual({
        model: "opus-4",
        promptTokens: 100,
        completionTokens: 50,
      });
    });
  });
});

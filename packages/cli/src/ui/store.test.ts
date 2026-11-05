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
      const store = new UIStore();
      store.printOutput(entry("a"));
      store.printOutput(entry("b"));
      expect(store.getOutputSnapshot().entries).toHaveLength(0);

      await Promise.resolve();
      expect(store.getOutputSnapshot().entries).toHaveLength(2);
      expect(store.getOutputSnapshot().entries[0]!.message).toBe("a");
      expect(store.getOutputSnapshot().entries[1]!.message).toBe("b");
    });

    test("assigns unique ids to printed entries", () => {
      const store = new UIStore();
      const id1 = store.printOutput(entry("a"));
      const id2 = store.printOutput(entry("b"));

      expect(id1).not.toBe(id2);
      expect(id1).toContain("queued-output-");
      expect(id2).toContain("queued-output-");
    });

    test("preserves caller-provided id", async () => {
      const store = new UIStore();
      const id = store.printOutput({ ...entry(), id: "custom-id" });

      expect(id).toBe("custom-id");
      store.flushOutputBatchNow();
      expect(store.getOutputSnapshot().entries[0]!.id).toBe("custom-id");
    });
  });

  // -------------------------------------------------------------------------
  // Handler registration — entries bypass queue
  // -------------------------------------------------------------------------

  describe("subscribe slices", () => {
    test("publishes replacement generations coherently while stream revisions keep their lifetime", async () => {
      const store = new UIStore();
      const observed: Array<{ generation: number; documentId: string }> = [];
      store.subscribePresentation(() => {
        const snapshot = store.getPresentationSnapshot();
        observed.push({
          generation: snapshot.documentGeneration,
          documentId: snapshot.document.id,
        });
      });
      expect(store.getPresentationSnapshot().documentGeneration).toBe(0);
      store.replaceDocument("same-source-id", []);
      expect(observed.at(-1)).toEqual({ generation: 1, documentId: "same-source-id" });
      store.appendStream("response", "accepted text");
      await Promise.resolve();
      expect(store.getPresentationSnapshot().documentGeneration).toBe(1);
      store.finalizeStream();
      await Promise.resolve();
      expect(store.getPresentationSnapshot().documentGeneration).toBe(1);
      store.replaceDocument("same-source-id", []);
      expect(observed.at(-1)).toEqual({ generation: 2, documentId: "same-source-id" });
      store.clearOutputs();
      await Promise.resolve();
      expect(observed.at(-1)).toEqual({ generation: 3, documentId: "session:3" });
    });

    test("output subscribe is multicast — both trees see the same snapshot", async () => {
      const store = new UIStore();
      const ink: OutputEntry[][] = [];
      const fullscreen: OutputEntry[][] = [];
      store.subscribeOutput(() => ink.push([...store.getOutputSnapshot().entries]));
      store.subscribeOutput(() => fullscreen.push([...store.getOutputSnapshot().entries]));

      store.printOutput(entry("hello"));
      await Promise.resolve();

      expect(ink).toHaveLength(1);
      expect(fullscreen).toHaveLength(1);
      expect(ink[0]).toEqual(fullscreen[0]);
      expect(ink[0]![0]!.message).toBe("hello");
      expect(store.getOutputSnapshot()).toBe(store.getOutputSnapshot());
    });

    test("getSnapshot is Object.is-stable across reads and unrelated writes", () => {
      const store = new UIStore();
      const output = store.getOutputSnapshot();
      const session = store.getSessionSnapshot();
      const prompt = store.getPromptSlice();
      const ephemeral = store.getEphemeralSnapshot();

      expect(store.getOutputSnapshot()).toBe(output);
      expect(store.getSessionSnapshot()).toBe(session);
      expect(store.getPromptSlice()).toBe(prompt);
      expect(store.getEphemeralSnapshot()).toBe(ephemeral);

      store.setActivity({ phase: "thinking", agentName: "A" });
      expect(store.getOutputSnapshot()).toBe(output);
      expect(store.getPromptSlice()).toBe(prompt);
      expect(store.getEphemeralSnapshot()).toBe(ephemeral);
      expect(store.getSessionSnapshot()).not.toBe(session);
      expect(store.getSessionSnapshot()).toBe(store.getSessionSnapshot());
    });

    test("session subscribe is multicast", () => {
      const store = new UIStore();
      let ink = 0;
      let fullscreen = 0;
      store.subscribeSession(() => {
        ink += 1;
      });
      store.subscribeSession(() => {
        fullscreen += 1;
      });

      store.setChatBusy(true);
      expect(ink).toBe(1);
      expect(fullscreen).toBe(1);
      store.setChatBusy(true);
      expect(ink).toBe(1);
      expect(fullscreen).toBe(1);
    });

    test("unsubscribing one tree does not silence the other", async () => {
      const store = new UIStore();
      let ink = 0;
      let fullscreen = 0;
      const unsubscribeInk = store.subscribeOutput(() => {
        ink += 1;
      });
      store.subscribeOutput(() => {
        fullscreen += 1;
      });

      store.printOutput(entry("a"));
      store.flushOutputBatchNow();
      await Promise.resolve();
      unsubscribeInk();
      store.printOutput(entry("b"));
      store.flushOutputBatchNow();
      await Promise.resolve();

      expect(ink).toBe(1);
      expect(fullscreen).toBe(2);
    });

    test("stale renderer cleanup does not unregister a newer fallback handler", () => {
      const store = new UIStore();
      let fallbackRequests = 0;
      const unregisterFirst = store.registerRendererFallbackHandler(() => {
        fallbackRequests += 100;
      });
      const unregisterSecond = store.registerRendererFallbackHandler(() => {
        fallbackRequests += 1;
      });

      unregisterFirst();
      store.requestRendererFallback();
      expect(fallbackRequests).toBe(1);

      unregisterSecond();
      store.requestRendererFallback();
      expect(fallbackRequests).toBe(1);
    });

    test("both session subscribers see a data-only menu", () => {
      const store = new UIStore();
      const ink: Array<ActiveMenu | null> = [];
      const fullscreen: Array<ActiveMenu | null> = [];
      const menu: ActiveMenu = {
        kind: "menu",
        options: [{ label: "Start chatting", value: "chat" }],
      };
      store.subscribeSession(() => ink.push(store.getActiveMenuSnapshot()));
      store.subscribeSession(() => fullscreen.push(store.getActiveMenuSnapshot()));

      store.setActiveMenu(menu);
      store.setActiveMenu(null);

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
      const store = new UIStore();
      const run = store.beginCommandPanel();
      expect(store.getCommandPanelSnapshot()).toBe(null);

      store.appendCommandPanel(run, "/info", text("one"));
      store.appendCommandPanel(run, "/info", text("two"));
      expect(store.getCommandPanelSnapshot()?.entries).toEqual([text("one"), text("two")]);
    });

    test("a newer run replaces the panel and an older run's late output is dropped", () => {
      const store = new UIStore();
      const older = store.beginCommandPanel();
      const newer = store.beginCommandPanel();
      store.appendCommandPanel(older, "/info", text("old"));
      store.appendCommandPanel(newer, "/cost", text("new"));
      store.appendCommandPanel(older, "/info", text("late"));

      expect(store.getCommandPanelSnapshot()).toEqual({
        id: newer,
        command: "/cost",
        entries: [text("new")],
      });
    });

    test("output after the panel was closed does not reopen it", () => {
      const store = new UIStore();
      const run = store.beginCommandPanel();
      store.appendCommandPanel(run, "/info", text("first"));
      store.closeCommandPanel();
      store.appendCommandPanel(run, "/info", text("second"));
      expect(store.getCommandPanelSnapshot()).toBe(null);
    });

    test("runs a command immediately only through the registered runner", () => {
      const store = new UIStore();
      expect(store.runCommandImmediately("/info")).toBe(false);
      const seen: string[] = [];
      store.registerImmediateCommandRunner((command) => (seen.push(command), true));
      expect(store.runCommandImmediately("  /info  ")).toBe(true);
      expect(seen).toEqual(["/info"]);
    });
  });

  describe("theme picker prompt", () => {
    test("a prompt the session needs dismisses the theme picker", () => {
      const store = new UIStore();
      let dismissed = 0;
      store.setPrompt({
        type: "theme",
        message: "Theme",
        resolve: () => undefined,
        reject: () => (dismissed += 1),
      });
      const question = { type: "chat" as const, message: "You:", resolve: () => undefined };
      store.setPrompt(question);
      expect(dismissed).toBe(1);
      expect(store.getPromptSnapshot()).toBe(question);
    });
  });

  describe("chat prompt set aside", () => {
    const chatPrompt = () => ({ type: "chat" as const, message: "You:", resolve: () => undefined });
    const approval = () => ({
      type: "select" as const,
      message: "Approve this action?",
      resolve: () => undefined,
    });

    test("comes back once a prompt that took its place closes", () => {
      const store = new UIStore();
      const chat = chatPrompt();
      store.setPrompt(chat);
      store.setPrompt(approval());
      expect(store.getPromptSnapshot()?.type).toBe("select");
      store.setPrompt(null);
      expect(store.getPromptSnapshot()).toBe(chat);
    });

    test("stays gone once withdrawn while set aside", () => {
      const store = new UIStore();
      const chat = chatPrompt();
      store.setPrompt(chat);
      store.setPrompt(approval());
      store.withdrawPrompt(chat);
      store.setPrompt(null);
      expect(store.getPromptSnapshot()).toBeNull();
    });

    test("closes when withdrawn while showing, and not when another prompt shows", () => {
      const store = new UIStore();
      const chat = chatPrompt();
      store.setPrompt(chat);
      store.withdrawPrompt(chat);
      expect(store.getPromptSnapshot()).toBeNull();
      const shown = approval();
      store.setPrompt(shown);
      store.withdrawPrompt(chat);
      expect(store.getPromptSnapshot()).toBe(shown);
    });

    test("a chat prompt opened while a question shows waits behind it", () => {
      const store = new UIStore();
      const shown = approval();
      store.setPrompt(shown);
      const chat = chatPrompt();
      store.setPrompt(chat);
      expect(store.getPromptSnapshot()).toBe(shown);
      store.setPrompt(null);
      expect(store.getPromptSnapshot()).toBe(chat);
    });

    test("answering the chat prompt itself leaves nothing to bring back", () => {
      const store = new UIStore();
      store.setPrompt(chatPrompt());
      store.setPrompt(null);
      store.setPrompt(approval());
      store.setPrompt(null);
      expect(store.getPromptSnapshot()).toBeNull();
    });
  });

  describe("completePrompt", () => {
    test("keeps the snapshot data-only and runs the continuation once", () => {
      const store = new UIStore();
      const results: string[] = [];
      store.setActiveMenu(
        {
          kind: "menu",
          options: [{ label: "Start chatting", value: "chat" }],
        },
        (result) => results.push(result.kind === "exit" ? "exit" : result.value),
      );

      const snapshot = store.getActiveMenuSnapshot();
      expect(snapshot).not.toHaveProperty("onSelect");
      expect(snapshot).not.toHaveProperty("onExit");
      if (snapshot !== null) {
        for (const value of Object.values(snapshot)) {
          expect(typeof value).not.toBe("function");
        }
      }

      store.completePrompt({ kind: "select", value: "chat" });
      store.completePrompt({ kind: "select", value: "again" });
      expect(results).toEqual(["chat"]);
      expect(store.getActiveMenuSnapshot()).toBe(null);
    });

    test("drops a pending continuation when the menu is cleared", () => {
      const store = new UIStore();
      let called = 0;
      store.setActiveMenu({ kind: "menu", options: [{ label: "Go", value: "go" }] }, () => {
        called += 1;
      });
      store.setActiveMenu(null);
      store.completePrompt({ kind: "exit" });
      expect(called).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // clearOutputs
  // -------------------------------------------------------------------------

  describe("clearOutputs", () => {
    test("clears the output snapshot immediately", () => {
      const store = new UIStore();
      store.printOutput(entry("a"));
      store.printOutput(entry("b"));
      store.flushOutputBatchNow();
      expect(store.getOutputSnapshot().entries).toHaveLength(2);

      store.clearOutputs();

      expect(store.getOutputSnapshot().entries).toHaveLength(0);
      expect(store.getOutputSnapshot().streaming).toBe("");
    });

    test("discards pending batched outputs to prevent post-clear race", async () => {
      const store = new UIStore();
      store.printOutput(entry("a"));
      store.printOutput(entry("b"));
      store.clearOutputs();

      await Promise.resolve();
      expect(store.getOutputSnapshot().entries).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Activity snapshots
  // -------------------------------------------------------------------------

  describe("activity snapshots", () => {
    test("stores and returns activity snapshot", () => {
      const store = new UIStore();
      expect(store.getActivitySnapshot()).toEqual({ phase: "idle" });

      store.setActivity({ phase: "thinking", agentName: "A" });
      expect(store.getActivitySnapshot()).toEqual({ phase: "thinking", agentName: "A" });
    });

    test("notifies session subscribers", () => {
      const store = new UIStore();
      const calls: unknown[] = [];
      store.subscribeSession(() => calls.push(store.getActivitySnapshot()));

      store.setActivity({ phase: "thinking", agentName: "A" });
      expect(calls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Expandable diff
  // -------------------------------------------------------------------------

  describe("expandable diff", () => {
    test("returns null when no diff is set", () => {
      const store = new UIStore();
      expect(store.getExpandableDiff()).toBeNull();
    });

    test("stores and retrieves diff", () => {
      const store = new UIStore();
      store.setExpandableDiff("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new");

      const payload = store.getExpandableDiff();
      expect(payload).not.toBeNull();
      expect(payload!.fullDiff).toBe("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new");
      expect(payload!.timestamp).toBeGreaterThan(0);
    });

    test("clear resets to null", () => {
      const store = new UIStore();
      store.setExpandableDiff("diff content");
      expect(store.getExpandableDiff()).not.toBeNull();

      store.clearExpandableDiff();
      expect(store.getExpandableDiff()).toBeNull();
    });
  });

  describe("interrupt handler stack", () => {
    test("nested handlers all receive an interrupt, and inner pop restores outer dispatch", () => {
      const store = new UIStore();
      const calls: string[] = [];
      const outer = (): void => void calls.push("outer");
      const inner = (): void => void calls.push("inner");

      store.setInterruptHandler(outer);
      store.setInterruptHandler(inner);
      store.getSessionSnapshot().interruptHandler?.();
      expect(calls).toEqual(["inner", "outer"]);

      calls.length = 0;
      store.setInterruptHandler(null);
      store.getSessionSnapshot().interruptHandler?.();
      expect(calls).toEqual(["outer"]);
    });

    test("popping below empty is a no-op (over-pop tolerated)", () => {
      const store = new UIStore();
      expect(() => store.setInterruptHandler(null)).not.toThrow();
    });

    test("unsubscribing does not drop the interrupt stack", () => {
      const store = new UIStore();
      const unsubscribe = store.subscribeSession(() => undefined);

      const handler = (): void => {};
      store.setInterruptHandler(handler);
      unsubscribe();

      expect(store.getSessionSnapshot().interruptHandler).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Ephemeral live regions
  // -------------------------------------------------------------------------

  describe("ephemeral regions", () => {
    test("openEphemeral returns unique ids and adds to snapshot", () => {
      const store = new UIStore();
      const firstRegionId = store.openEphemeral("reasoning", "Reasoning", 8);
      const secondRegionId = store.openEphemeral("subagent", "Sub-Agent (researcher)", 12);

      expect(firstRegionId).not.toBe(secondRegionId);
      const regions = store.getEphemeralRegionsSnapshot();
      expect(regions).toHaveLength(2);
      expect(regions[0]!.id).toBe(firstRegionId);
      expect(regions[0]!.kind).toBe("reasoning");
      expect(regions[1]!.id).toBe(secondRegionId);
      expect(regions[1]!.kind).toBe("subagent");
    });

    test("appendEphemeral splits, merges first chunk, trims to last N lines", () => {
      const store = new UIStore();
      const id = store.openEphemeral("reasoning", "Reasoning", 3);

      store.appendEphemeral(id, "first ");
      store.appendEphemeral(id, "line\nsecond\n");
      store.appendEphemeral(id, "third\nfourth\nfifth");

      const region = store.getEphemeralRegionsSnapshot()[0]!;
      // Expected lines after merge+split:
      //   "first line", "second", "", "third", "fourth", "fifth"
      // Hmm — "second\n" leaves a trailing empty. Then "third" appends to that
      // empty as the first chunk merge. So actual sequence:
      //   ["first line", "second", "third", "fourth", "fifth"]
      // Trimmed to last 3:
      //   ["third", "fourth", "fifth"]
      expect(region.tail).toEqual(["third", "fourth", "fifth"]);
    });

    test("replaceEphemeral swaps the whole tail instead of adding to it", () => {
      const store = new UIStore();
      const id = store.openEphemeral("subagent", "Compacting", 3);

      store.appendEphemeral(id, "Reviewing tool results…");
      store.replaceEphemeral(id, "frame one");
      store.replaceEphemeral(id, "phase\nframe two");

      expect(store.getEphemeralRegionsSnapshot()[0]!.tail).toEqual(["phase", "frame two"]);
    });

    test("appendEphemeral targets only the specified region", () => {
      const store = new UIStore();
      const firstRegionId = store.openEphemeral("reasoning", "Reasoning", 8);
      const secondRegionId = store.openEphemeral("subagent", "Sub", 8);

      store.appendEphemeral(firstRegionId, "hello");
      store.appendEphemeral(secondRegionId, "world");

      const regions = store.getEphemeralRegionsSnapshot();
      expect(regions[0]!.tail).toEqual(["hello"]);
      expect(regions[1]!.tail).toEqual(["world"]);
    });

    test("collapseEphemeral removes the region, and the turn's line lands when it settles", () => {
      const store = new UIStore();

      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(id, {
        line: "✓ Reasoning · 12s · 100 tokens",
        durationMs: 12000,
      });

      expect(store.getEphemeralRegionsSnapshot()).toHaveLength(0);
      store.flushOutputBatchNow();
      expect(store.getOutputSnapshot().entries).toHaveLength(0);
      store.settleTurnThought();
      expect(store.getOutputSnapshot().entries).toHaveLength(1);
      expect(store.getOutputSnapshot().entries[0]!.message).toMatchObject({
        kind: "reasoning",
        durationMs: 12000,
      });
    });

    test("collapseEphemeral keeps the live tail when fullText is missing", () => {
      const store = new UIStore();
      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.appendEphemeral(id, "kept from the live panel");
      store.collapseEphemeral(id, { durationMs: 800 });
      store.settleTurnThought();

      expect(store.getExpandableReasoningSnapshot()?.fullText).toBe("kept from the live panel");
    });

    test("collapseEphemeral with reasoning + fullText populates expandableReasoning", () => {
      const store = new UIStore();
      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(id, {
        durationMs: 5000,
        tokens: 42,
        fullText: "I was thinking about X then Y",
      });
      store.settleTurnThought();

      const expandable = store.getExpandableReasoningSnapshot();
      expect(expandable).not.toBeNull();
      expect(expandable!.fullText).toBe("I was thinking about X then Y");
      expect(expandable!.durationMs).toBe(5000);
      expect(expandable!.tokens).toBe(42);
    });

    test("subagent collapse does NOT populate expandableReasoning", () => {
      const store = new UIStore();
      const id = store.openEphemeral("subagent", "Sub-Agent", 12);
      store.collapseEphemeral(id, {
        durationMs: 1000,
        fullText: "subagent body — should be ignored for expand",
      });

      expect(store.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("collapseAllEphemeral removes every open region without emitting summaries", () => {
      const store = new UIStore();

      store.openEphemeral("reasoning", "R", 8);
      store.openEphemeral("subagent", "S1", 12);
      store.openEphemeral("subagent", "S2", 12);

      store.collapseAllEphemeral();

      expect(store.getEphemeralRegionsSnapshot()).toHaveLength(0);
      expect(store.getOutputSnapshot().entries).toHaveLength(0);
    });

    test("expandLastReasoning rewrites the collapsed entry in place", () => {
      const store = new UIStore();

      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(id, {
        durationMs: 1000,
        fullText: "full reasoning body",
      });
      store.settleTurnThought();

      expect(store.getOutputSnapshot().entries).toHaveLength(1);
      expect(store.isReasoningExpanded(store.getOutputSnapshot().entries[0]!.id)).toBe(false);

      store.expandLastReasoning();
      store.expandLastReasoning(); // second call is no-op

      const printed = store.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(printed[0]!.type).toBe("streamContent");
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "full reasoning body" });
      expect(store.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(store.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("expandLastReasoning('append') adds a fresh entry so Ink's Static can show it", () => {
      const store = new UIStore();

      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(id, { durationMs: 1000, fullText: "full reasoning body" });
      store.settleTurnThought();

      expect(store.getOutputSnapshot().entries).toHaveLength(1);

      store.expandLastReasoning("append");

      const printed = store.getOutputSnapshot().entries;
      expect(printed).toHaveLength(2);
      expect(store.isReasoningExpanded(printed[0]!.id)).toBe(false);
      expect(printed[1]!.message).toMatchObject({ kind: "reasoning", text: "full reasoning body" });
      expect(printed[1]!.id).not.toBe(printed[0]!.id);
      expect(store.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("expandLastReasoning expands earlier turns without moving them", () => {
      const store = new UIStore();

      const first = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(first, { durationMs: 500, fullText: "first block" });
      store.settleTurnThought();
      const second = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(second, { durationMs: 700, fullText: "second block" });
      store.settleTurnThought();

      store.expandLastReasoning();
      store.expandLastReasoning();
      store.expandLastReasoning(); // stack empty — no-op

      const printed = store.getOutputSnapshot().entries;
      expect(printed).toHaveLength(2);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "first block" });
      expect(printed[1]!.message).toMatchObject({ kind: "reasoning", text: "second block" });
      expect(store.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("expandLastReasoning opens the current turn's folded steps before earlier turns", () => {
      const store = new UIStore();

      const earlier = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(earlier, { durationMs: 500, fullText: "earlier turn" });
      store.settleTurnThought();
      const firstStep = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(firstStep, { durationMs: 300, fullText: "step one" });
      const secondStep = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(secondStep, { durationMs: 400, fullText: "step two" });

      expect(store.expandLastReasoning()).toBe(true);
      expect(store.isReasoningExpanded(firstStep)).toBe(true);
      expect(store.isReasoningExpanded(secondStep)).toBe(true);
      expect(store.isReasoningExpanded(earlier)).toBe(false);

      store.settleTurnThought();
      expect(store.expandLastReasoning()).toBe(true);
      expect(store.isReasoningExpanded(earlier)).toBe(true);
    });

    test("Ctrl+R during a live panel pins it so collapse stays expanded", () => {
      const store = new UIStore();

      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.appendEphemeral(id, "live thought");
      expect(store.expandLastReasoning()).toBe(true);
      store.collapseEphemeral(id, { durationMs: 400, fullText: "live thought" });

      const printed = store.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(store.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "live thought" });
    });

    test("setCollapseReasoning(false) settles reasoning expanded without Ctrl+R", () => {
      const store = new UIStore();
      store.setCollapseReasoning(false);

      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.collapseEphemeral(id, { durationMs: 1500, fullText: "the whole thought" });

      const printed = store.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(store.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "the whole thought" });
      expect(store.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("setCollapseReasoning(false) dumps in-flight reasoning on collapseAllEphemeral", () => {
      const store = new UIStore();
      store.setCollapseReasoning(false);

      const id = store.openEphemeral("reasoning", "Reasoning", 8);
      store.appendEphemeral(id, "interrupted thought");
      store.collapseAllEphemeral();

      expect(store.getEphemeralRegionsSnapshot()).toHaveLength(0);
      const printed = store.getOutputSnapshot().entries;
      expect(printed).toHaveLength(1);
      expect(store.isReasoningExpanded(printed[0]!.id)).toBe(true);
      expect(printed[0]!.message).toMatchObject({ kind: "reasoning", text: "interrupted thought" });
      expect(store.getExpandableReasoningSnapshot()).toBeNull();
    });

    test("ephemeral subscribers are notified on open, append, and collapse", () => {
      const store = new UIStore();
      const seen: number[] = [];
      store.subscribeEphemeral(() => seen.push(store.getEphemeralSnapshot().regions.length));

      const id = store.openEphemeral("reasoning", "R", 8);
      store.appendEphemeral(id, "x");
      store.collapseEphemeral(id, { durationMs: 1, line: "✓ R" });

      expect(seen.slice(0, 3)).toEqual([1, 1, 0]);
      expect(seen.at(-1)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Message queue (chat busy-mode buffering)
  // -------------------------------------------------------------------------

  describe("message queue", () => {
    test("signals queued prose once, and not for a queued command", () => {
      const store = new UIStore();
      let signalled = 0;
      store.onceQueuedProse(() => (signalled += 1));
      store.appendToQueue("/help");
      expect(signalled).toBe(0);
      store.clearQueue();
      store.appendToQueue("also check the tests");
      store.appendToQueue("and the docs");
      expect(signalled).toBe(1);
      let immediate = 0;
      store.onceQueuedProse(() => (immediate += 1));
      expect(immediate).toBe(1);
    });

    test("a cancelled queued-prose listener is never called", () => {
      const store = new UIStore();
      let signalled = 0;
      const cancel = store.onceQueuedProse(() => (signalled += 1));
      cancel();
      store.appendToQueue("hello");
      expect(signalled).toBe(0);
    });

    test("appendToQueue stores each entry as its own array element", () => {
      const store = new UIStore();
      store.appendToQueue("first");
      store.appendToQueue("second");
      store.appendToQueue("third");

      expect(store.getMessageQueueSnapshot()).toEqual(["first", "second", "third"]);
    });

    test("peekQueue joins entries with newlines for back-compat with the chat-loop drain", () => {
      const store = new UIStore();
      store.appendToQueue("first");
      store.appendToQueue("second");

      expect(store.peekQueue()).toBe("first\nsecond");
    });

    test("appendToQueue with empty string is a no-op", () => {
      const store = new UIStore();
      store.appendToQueue("only");
      store.appendToQueue("");

      expect(store.getMessageQueueSnapshot()).toEqual(["only"]);
    });

    test("takeQueue returns the joined string and clears the array", () => {
      const store = new UIStore();
      store.appendToQueue("hello");
      store.appendToQueue("world");

      expect(store.takeQueue()).toBe("hello\nworld");
      expect(store.getMessageQueueSnapshot()).toEqual([]);
    });

    test("takeQueue on empty queue returns empty string", () => {
      const store = new UIStore();
      expect(store.takeQueue()).toBe("");
    });

    test("takeQueuedTurn pops a head command alone and leaves the rest queued", () => {
      const store = new UIStore();
      store.appendToQueue("/info");
      store.appendToQueue("keep going");
      store.appendToQueue("and this");

      expect(store.takeQueuedTurn()).toEqual(["/info"]);
      expect(store.getMessageQueueSnapshot()).toEqual(["keep going", "and this"]);
      expect(store.takeQueuedTurn()).toEqual(["keep going", "and this"]);
      expect(store.getMessageQueueSnapshot()).toEqual([]);
    });

    test("takeQueuedTurn stops a prose run at the next command", () => {
      const store = new UIStore();
      store.appendToQueue("first");
      store.appendToQueue("! git status");
      store.appendToQueue("last");

      expect(store.takeQueuedTurn()).toEqual(["first"]);
      expect(store.takeQueuedTurn()).toEqual(["! git status"]);
      expect(store.takeQueuedTurn()).toEqual(["last"]);
      expect(store.takeQueuedTurn()).toEqual([]);
    });

    test("takeQueuedProse never pops a command, so mid-run injection skips it", () => {
      const store = new UIStore();
      store.appendToQueue("/compact");
      store.appendToQueue("note");
      expect(store.takeQueuedProse()).toEqual([]);
      expect(store.getMessageQueueSnapshot()).toEqual(["/compact", "note"]);

      const secondStore = new UIStore();
      secondStore.appendToQueue("a");
      secondStore.appendToQueue("/slash\nstill prose");
      secondStore.appendToQueue("/help");
      expect(secondStore.takeQueuedProse()).toEqual(["a", "/slash\nstill prose"]);
      expect(secondStore.getMessageQueueSnapshot()).toEqual(["/help"]);
    });

    test("clearQueue empties the array", () => {
      const store = new UIStore();
      store.appendToQueue("a");
      store.appendToQueue("b");
      store.clearQueue();

      expect(store.getMessageQueueSnapshot()).toEqual([]);
    });

    test("prompt subscribers receive the queue on append, clear, and take", () => {
      const store = new UIStore();
      const seen: (readonly string[])[] = [];
      store.subscribePrompt(() => {
        seen.push([...store.getPromptSlice().messageQueue]);
      });

      store.appendToQueue("a");
      store.appendToQueue("b");
      store.takeQueue();
      store.appendToQueue("c");
      store.clearQueue();

      expect(seen).toEqual([["a"], ["a", "b"], [], ["c"], []]);
    });

    test("clearQueue when already empty does not notify subscribers", () => {
      const store = new UIStore();
      const seen: (readonly string[])[] = [];
      store.subscribePrompt(() => seen.push(store.getPromptSlice().messageQueue));

      store.clearQueue();
      expect(seen).toEqual([]);
    });

    test("requestFlushQueue/consumeFlushQueue is a one-shot flag", () => {
      const store = new UIStore();
      expect(store.consumeFlushQueue()).toBe(false);
      store.requestFlushQueue();
      expect(store.consumeFlushQueue()).toBe(true);
      expect(store.consumeFlushQueue()).toBe(false);
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
      const store = new UIStore();
      store.printContent({ kind: "tool", receipt: commandReceipt("git a", "one\ntwo") }, "tool-a");
      store.printContent(
        { kind: "tool", receipt: commandReceipt("git b", "three\nfour") },
        "tool-b",
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const [first, second] = store.getDocumentSnapshot().entries;

      expect(store.toggleLastReceiptOutput()).toBe(true);
      expect((await expandedIds(store)).has(second?.id ?? "")).toBe(true);
      expect((await expandedIds(store)).has(first?.id ?? "")).toBe(false);

      expect(store.toggleLastReceiptOutput()).toBe(true);
      expect((await expandedIds(store)).size).toBe(0);
    });

    test("reports nothing to expand when every receipt fits its preview", async () => {
      const store = new UIStore();
      store.printContent({ kind: "tool", receipt: commandReceipt("echo hi", "hi") }, "tool");
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(store.toggleLastReceiptOutput()).toBe(false);
    });
  });

  describe("chatBusy", () => {
    test("setChatBusy toggles snapshot", () => {
      const store = new UIStore();
      expect(store.getChatBusySnapshot()).toBe(false);
      store.setChatBusy(true);
      expect(store.getChatBusySnapshot()).toBe(true);
      store.setChatBusy(false);
      expect(store.getChatBusySnapshot()).toBe(false);
    });

    test("a turn ending mid-retry does not bring its countdown back on the next send", () => {
      const store = new UIStore();
      store.setChatBusy(true);
      store.setRetryNotice({
        agentName: "agent",
        reason: "rate limit",
        detail: "",
        attempt: 7,
        maxAttempts: 10,
        retryInMs: 30_000,
        retryAt: Date.now() + 30_000,
      });
      store.setChatBusy(false);
      expect(store.getSessionSnapshot().retryNotice).toBeNull();

      store.setRetryNotice({
        agentName: "agent",
        reason: "rate limit",
        detail: "",
        attempt: 7,
        maxAttempts: 10,
        retryInMs: 30_000,
        retryAt: Date.now() + 30_000,
      });
      store.setChatBusy(true);
      expect(store.getSessionSnapshot().retryNotice).toBeNull();
    });

    test("session subscribers are notified on change but not on no-op", () => {
      const store = new UIStore();
      const seen: boolean[] = [];
      store.subscribeSession(() => seen.push(store.getChatBusySnapshot()));

      store.setChatBusy(true);
      store.setChatBusy(true); // no-op
      store.setChatBusy(false);
      store.setChatBusy(false); // no-op

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

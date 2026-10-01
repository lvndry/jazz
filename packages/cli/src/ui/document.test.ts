/** Tests source identity, projection independence, and atomic presentation commits. */
import type { PresentationDocument } from "@jazz/core/types/presentation-content";
import { describe, expect, test } from "bun:test";
import { createAccumulator, reduceEvent } from "../presentation/activity-reducer";
import { createClassicProjection } from "./adapters/terminal-output-adapter";
import { appendDocumentStream, settleDocumentStream, projectDocumentEntries } from "./document";
import { UIStore } from "./store";

const initial = (): PresentationDocument => ({ id: "conversation", revision: 0, entries: [] });

describe("presentation document", () => {
  test("retains one answer identity and full source through promotion and settlement", () => {
    const project = createClassicProjection();
    let document = appendDocumentStream(
      initial(),
      "response",
      "First paragraph.\n\n" + "Second ".repeat(100),
      "answer-1",
      "2026-01-01T00:00:00.000Z",
    );
    const first = project(document);
    expect(first.entries.length).toBeGreaterThan(0);
    expect(first.pending?.rawTail).toBe("Second ".repeat(100));
    document = appendDocumentStream(
      document,
      "response",
      " paragraph.",
      "unused-id",
      "2026-01-01T00:00:01.000Z",
    );
    document = settleDocumentStream(document);
    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]?.id).toBe("answer-1");
    expect(document.entries[0]?.content).toEqual({
      kind: "agent",
      markdown: "First paragraph.\n\n" + "Second ".repeat(100) + " paragraph.",
    });
    const settled = project(document);
    expect(settled.pending).toBeNull();
    expect(
      settled.entries
        .map((entry) =>
          typeof entry.message !== "string" &&
          "kind" in entry.message &&
          entry.message.kind === "agent"
            ? entry.message.markdown
            : "",
        )
        .join(""),
    ).toBe("First paragraph.\n\n" + "Second ".repeat(100) + " paragraph.");
    expect(settled.entries[0]).toBe(first.entries[0]);
  });

  test("publishes output and activity as one coherent revision", async () => {
    const store = new UIStore();
    const seen: Array<{ text: string; phase: string }> = [];
    store.subscribePresentation(() => {
      const snapshot = store.getPresentationSnapshot();
      const content = snapshot.document.entries.at(-1)?.content;
      seen.push({
        text: content?.kind === "notice" ? content.text : "",
        phase: snapshot.session.activity.phase,
      });
    });
    store.setActivity({ phase: "thinking", agentName: "jazz" });
    store.printOutput({ type: "log", message: "accepted", timestamp: new Date() });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(seen).toEqual([{ text: "accepted", phase: "thinking" }]);
  });
  test("keeps the initial external-store snapshot stable", () => {
    const store = new UIStore();
    expect(store.getPresentationSnapshot()).toBe(store.getPresentationSnapshot());
  });

  test("accepted text is durable immediately while reveal owns only a prefix", async () => {
    const store = new UIStore();
    store.setStreamPacing(true);
    const full = "a provider burst with enough words to remain paced ".repeat(20);
    store.appendStream("response", full);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const snapshot = store.getPresentationSnapshot();
    expect(snapshot.document.entries).toHaveLength(1);
    expect(snapshot.document.entries[0]?.content).toEqual({ kind: "agent", markdown: full });
    expect(snapshot.streamReveal).toMatchObject({ id: snapshot.document.streamingId, length: 0 });
    expect(
      projectDocumentEntries(snapshot.document, { streamReveal: snapshot.streamReveal })[0]
        ?.content,
    ).toEqual({ kind: "agent", markdown: "" });
    const id = snapshot.document.streamingId;
    store.finalizeStream();
    expect(store.getDocumentSnapshot().entries).toHaveLength(1);
    expect(store.getDocumentSnapshot().entries[0]?.id).toBe(id);
    expect(store.getDocumentSnapshot().entries[0]?.content).toEqual({
      kind: "agent",
      markdown: full,
    });
    store.setStreamPacing(false);
  });

  test("clear and same-ID replacement invalidate queued output and reveal work", async () => {
    const store = new UIStore();
    store.setStreamPacing(true);
    store.appendStream("response", "old accepted text ".repeat(50));
    store.printOutput({ type: "log", message: "old queued output", timestamp: new Date() });
    store.replaceDocument("conversation", [
      {
        id: "fresh",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: { kind: "user", text: "fresh question" },
      },
    ]);
    store.printOutput({ type: "log", message: "discard this too", timestamp: new Date() });
    store.clearOutputs();
    store.replaceDocument("conversation", [
      {
        id: "fresh",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: { kind: "user", text: "replacement question" },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(store.getDocumentSnapshot().entries).toEqual([
      {
        id: "fresh",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: { kind: "user", text: "replacement question" },
      },
    ]);
    expect(store.getOutputSnapshot().entries.map((entry) => entry.message)).toEqual([
      "replacement question",
    ]);
    expect(store.getPresentationSnapshot().streamReveal).toBeNull();
    store.setStreamPacing(false);
  });

  test("reasoning retains complete source and identity through bounded live tails and expansion", async () => {
    const store = new UIStore();
    const id = store.openEphemeral("reasoning", "Reasoning", 2);
    store.appendEphemeral(id, "first\nsecond\nthird\nfourth");
    expect(store.getEphemeralRegionsSnapshot()[0]?.tail).toEqual(["third", "fourth"]);
    store.collapseEphemeral(id, { durationMs: 1000 });
    store.settleTurnThought();
    const source = store.getDocumentSnapshot();
    expect(source.entries).toHaveLength(1);
    expect(source.entries[0]).toMatchObject({
      id,
      content: { kind: "reasoning", text: "first\nsecond\nthird\nfourth", durationMs: 1000 },
    });
    expect(store.expandLastReasoning("in-place")).toBe(true);
    expect(store.getDocumentSnapshot()).toBe(source);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(store.getPresentationSnapshot().expandedReasoningIds.has(id)).toBe(true);
  });

  test("classic settled reasoning appends after already emitted answer slices", () => {
    const store = new UIStore();
    const id = store.openEphemeral("reasoning", "Reasoning", 2);
    store.appendEphemeral(id, "a thought");
    store.collapseEphemeral(id, { durationMs: 1000 });
    store.appendStream("response", "answer paragraph.\n\n" + "tail ".repeat(100));
    store.finalizeStream();
    const before = store.getOutputSnapshot().entries;
    store.settleTurnThought();
    const after = store.getOutputSnapshot().entries;
    expect(after.slice(0, before.length)).toEqual([...before]);
    expect(after.at(-1)?.id).toBe(id);
    expect(store.getDocumentSnapshot().entries[0]?.id).toBe(id);
  });

  test("menu completion callbacks stay outside canonical source facts", async () => {
    const store = new UIStore();
    let completed = false;
    store.setActiveMenu(
      { kind: "menu", title: "Choose", options: [{ label: "Yes", value: "yes" }] },
      () => {
        completed = true;
      },
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(JSON.parse(JSON.stringify(store.getDocumentSnapshot()))).toEqual({
      id: "session:0",
      revision: 0,
      entries: [],
    });
    expect(JSON.stringify(store.getPresentationSnapshot().session.activeMenu)).toBe(
      '{"kind":"menu","title":"Choose","options":[{"label":"Yes","value":"yes"}]}',
    );
    store.completePrompt({ kind: "select", value: "yes" });
    expect(completed).toBe(true);
  });
  test("classic snapshots compute once on demand and preserve external-store stability", async () => {
    const store = new UIStore();
    store.appendStream("response", "accepted answer");
    const first = store.getOutputSnapshot();
    expect(store.getOutputSnapshot()).toBe(first);
    let publications = 0;
    const unsubscribe = store.subscribeOutput(() => {
      publications += 1;
    });
    store.appendStream("response", " more");
    const next = store.getOutputSnapshot();
    expect(next).not.toBe(first);
    expect(store.getOutputSnapshot()).toBe(next);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(publications).toBe(1);
    unsubscribe();
    const before = publications;
    store.appendStream("response", " while unobserved");
    expect(publications).toBe(before);
    expect(store.getOutputSnapshot().pending?.rawTail).toBe(
      "accepted answer more while unobserved",
    );
    store.finalizeStream();
  });
  test("64 accepted chunks produce one coherent classic publication without reordering receipts", async () => {
    const store = new UIStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribeOutput(() => {
      const snapshot = store.getOutputSnapshot();
      seen.push(snapshot.pending?.rawTail ?? "settled");
    });
    for (let index = 0; index < 64; index += 1)
      store.appendStream("response", `word${String(index)} `);
    expect(seen).toHaveLength(0);
    const accepted = store.getDocumentSnapshot();
    expect(accepted.entries).toHaveLength(1);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("word63");
    store.printContent(
      { kind: "tool", receipt: { app: "read_file", summary: "one file", status: "ok" } },
      "tool",
    );
    store.appendStream("response", "after tool");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(seen).toHaveLength(2);
    expect(store.getDocumentSnapshot().entries.map((entry) => entry.content.kind)).toEqual([
      "agent",
      "tool",
      "agent",
    ]);
    const classic = store.getOutputSnapshot();
    expect(classic.entries.map((entry) => entry.id)).toContain("tool");
    expect(classic.pending?.rawTail).toBe("after tool");
    unsubscribe();
    store.finalizeStream();
  });
  test("new source identities cannot collide with resumed IDs from another store instance", () => {
    const before = new UIStore();
    before.printOutput({ type: "user", message: "prior question", timestamp: new Date() });
    before.appendStream("response", "prior answer");
    before.finalizeStream();
    const saved = before.getDocumentSnapshot().entries;
    const restored = new UIStore();
    restored.replaceDocument("resumed", [
      ...saved,
      {
        id: "output-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: { kind: "agent", markdown: "older process format" },
      },
    ]);
    restored.printOutput({ type: "user", message: "new question", timestamp: new Date() });
    restored.appendStream("response", "new answer");
    restored.finalizeStream();
    const reasoningId = restored.openEphemeral("reasoning", "Reasoning", 2);
    restored.appendEphemeral(reasoningId, "new reasoning");
    restored.collapseEphemeral(reasoningId, { durationMs: 1 });
    restored.settleTurnThought();
    const ids = restored.getDocumentSnapshot().entries.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(restored.getDocumentSnapshot().entries.slice(0, saved.length)).toEqual([...saved]);
    expect(ids).toContain("output-1");
  });
  test("reused provider call IDs produce distinct receipts before and after resume", () => {
    const accumulator = createAccumulator("test");
    const complete = (target: UIStore, summary: string): void => {
      const result = reduceEvent(accumulator, {
        type: "tool_execution_complete",
        toolCallId: "provider-reused-call",
        toolName: "read_file",
        result: summary,
        summary,
        durationMs: 10,
        success: true,
      });
      for (const output of result.outputs) target.printOutput(output);
      target.flushOutputBatchNow();
    };
    const before = new UIStore();
    complete(before, "first file");
    complete(before, "second file");
    const saved = before.getDocumentSnapshot().entries;
    const resumed = new UIStore();
    resumed.replaceDocument("resumed", saved);
    complete(resumed, "third file");
    const receipts = resumed.getDocumentSnapshot().entries;
    expect(receipts).toHaveLength(3);
    expect(receipts.every((entry) => entry.content.kind === "tool")).toBe(true);
    expect(new Set(receipts.map((entry) => entry.id)).size).toBe(3);
    expect(receipts.slice(0, 2)).toEqual([...saved]);
  });
});

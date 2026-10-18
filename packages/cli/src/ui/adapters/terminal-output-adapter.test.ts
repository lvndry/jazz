/** Proves classic Static promotion is a disposable, lossless document projection. */
import type { PresentationDocument } from "@jazz/core/types/presentation-content";
import { describe, expect, test } from "bun:test";
import { appendDocumentEntries, appendDocumentStream, settleDocumentStream } from "../document";
import { UIStore } from "../store";
import { createClassicProjection, type ClassicProjection } from "./terminal-output-adapter";

const at = "2026-01-01T00:00:00.000Z";
const initial = (): PresentationDocument => ({ id: "document", revision: 0, entries: [] });
function text(projected: ClassicProjection): string {
  return (
    projected.entries
      .map((entry) =>
        typeof entry.message !== "string" &&
        "kind" in entry.message &&
        entry.message.kind === "agent"
          ? entry.message.markdown
          : "",
      )
      .join("") + (projected.pending?.rawTail ?? "")
  );
}

describe("classic output projection", () => {
  test("opens and settles the same source identity without editing source", () => {
    const project = createClassicProjection();
    let document = appendDocumentStream(initial(), "response", "hello ", "answer", at);
    expect(project(document).pending).toMatchObject({
      id: "answer",
      kind: "response",
      rawTail: "hello ",
    });
    document = appendDocumentStream(document, "response", "world", "unused", at);
    expect(text(project(document))).toBe("hello world");
    const source = document.entries;
    document = settleDocumentStream(document);
    const settled = project(document);
    expect(settled.pending).toBeNull();
    expect(document.entries).toBe(source);
    expect(document.entries[0]?.id).toBe("answer");
    expect(text(settled)).toBe("hello world");
  });

  test("kind changes settle the prior source without inventing a new identity", () => {
    const project = createClassicProjection();
    let document = appendDocumentStream(initial(), "reasoning", "thinking", "thought", at);
    project(document);
    document = appendDocumentStream(document, "response", "answer", "answer", at);
    const next = project(document);
    expect(next.entries[0]?.message).toMatchObject({ kind: "reasoning", text: "thinking" });
    expect(next.entries[0]?.id).toStartWith("thought");
    expect(next.pending).toMatchObject({ id: "answer", kind: "response", rawTail: "answer" });
    expect(document.entries.map((entry) => entry.id)).toEqual(["thought", "answer"]);
  });

  test("same document replacement invalidates promotion offsets and caches", () => {
    const project = createClassicProjection();
    const old = appendDocumentStream(
      initial(),
      "response",
      "Old paragraph.\n\n" + "x".repeat(500),
      "answer",
      at,
    );
    expect(project(old, 0).entries).toHaveLength(1);
    const replacement = appendDocumentStream(initial(), "response", "new", "answer", at);
    expect(text(project(replacement, 1))).toBe("new");
    expect(project(replacement, 1).entries).toHaveLength(0);
  });

  test("one-character provider deltas promote Markdown losslessly", () => {
    const full =
      "# Title\n\nIntro paragraph.\n\n- first item\n- second item\n\nProse after the list.\n\n```ts\nconst value = 1;\n```\n\nClosing paragraph with [a link](https://example.com).\n\n" +
      "z".repeat(400);
    const project = createClassicProjection();
    let document = initial();
    let projected = project(document);
    for (const character of full) {
      document = appendDocumentStream(document, "response", character, "answer", at);
      projected = project(document);
      expect(text(projected)).toBe(full.slice(0, text(projected).length));
    }
    expect(text(projected)).toBe(full);
    expect(projected.entries.length).toBeGreaterThan(3);
    expect(document.entries).toHaveLength(1);
    expect(text(project(settleDocumentStream(document)))).toBe(full);
  });

  test("thousands of deltas allocate slices per paragraph, not per token", () => {
    const project = createClassicProjection();
    let document = initial();
    for (let index = 0; index < 1000; index++) {
      document = appendDocumentStream(
        document,
        "response",
        `paragraph ${String(index)} body. ${"y".repeat(50)}\n\n`,
        "answer",
        at,
      );
      project(document);
    }
    const settled = project(settleDocumentStream(document));
    expect(settled.entries.length).toBeGreaterThanOrEqual(500);
    expect(settled.entries.length).toBeLessThanOrEqual(1001);
    expect(new Set(settled.entries.map((entry) => entry.id)).size).toBe(settled.entries.length);
  });

  test("reveal prefixes change the projection but never the accepted source", () => {
    const project = createClassicProjection();
    const document = appendDocumentStream(initial(), "response", "accepted answer", "answer", at);
    expect(text(project(document, 0, { streamReveal: { id: "answer", length: 8 } }))).toBe(
      "accepted",
    );
    expect(document.entries[0]?.content).toEqual({ kind: "agent", markdown: "accepted answer" });
    expect(text(createClassicProjection()(document))).toBe("accepted answer");
  });
  test("promoted copies preserve exact UTF-16 code units including unpaired surrogates", () => {
    const project = createClassicProjection();
    const full = "an unpaired high \ud800 and low \udc00 surrogate.\n\n" + "tail ".repeat(100);
    const source = appendDocumentStream(initial(), "response", full, "answer", at);
    expect(text(project(source))).toBe(full);
    expect(text(project(settleDocumentStream(source)))).toBe(full);
  });

  test("re-projecting earlier turns keeps a settled answer's slices in place", () => {
    const project = createClassicProjection();
    let document = appendDocumentEntries(initial(), [
      { id: "question-1", content: { kind: "user", text: "first" }, timestamp: at },
      {
        id: "thought-1",
        content: { kind: "reasoning", text: "why", label: "Reasoning", durationMs: 10 },
        timestamp: at,
      },
    ]);
    const paragraphs = [0, 1, 2, 3].map(
      (index) => `Paragraph ${String(index)} ${"words ".repeat(60)}ends.\n\n`,
    );
    for (const paragraph of paragraphs) {
      document = appendDocumentStream(document, "response", paragraph, "answer-1", at);
      project(document);
    }
    document = appendDocumentEntries(settleDocumentStream(document), [
      { id: "question-2", content: { kind: "user", text: "second" }, timestamp: at },
    ]);
    const settled = project(document);
    const ids = settled.entries.map((entry) => entry.id);
    expect(ids.filter((id) => id.startsWith("answer-1:slice:")).length).toBeGreaterThan(1);
    const expanded = project(document, 0, { expandedReasoningIds: new Set(["thought-1"]) });
    expect(expanded.entries.map((entry) => entry.id)).toEqual(ids);
    expect(text(expanded)).toBe(paragraphs.join(""));
  });

  test("printed history only grows, and later output lands after an expanded replay", async () => {
    const store = new UIStore();
    const seen: string[][] = [];
    store.subscribeOutput(() => {
      const ids = store.getOutputSnapshot().entries.map((entry) => entry.id);
      const before = seen.at(-1) ?? [];
      expect(ids.slice(0, before.length)).toEqual(before);
      seen.push(ids);
    });
    const commit = (): Promise<void> => Promise.resolve();
    store.printOutput({ type: "user", message: "question", timestamp: new Date(0) });
    await commit();
    const reasoning = store.openEphemeral("reasoning", "Reasoning", 4);
    store.appendEphemeral(reasoning, "weighing it");
    store.collapseEphemeral(reasoning, { durationMs: 100 });
    store.appendStream("response", "The answer.");
    store.finalizeStream();
    store.settleTurnThought();
    await commit();
    expect(store.expandLastReasoning("append")).toBe(true);
    await commit();
    const replayAt = store
      .getOutputSnapshot()
      .entries.findIndex((entry) => entry.id.includes(":expanded:"));
    expect(replayAt).toBeGreaterThan(0);
    store.printOutput({ type: "user", message: "next question", timestamp: new Date(0) });
    store.appendStream("response", "Next answer.");
    store.finalizeStream();
    await commit();
    const entries = store.getOutputSnapshot().entries;
    expect(entries[replayAt]?.id).toContain(":expanded:");
    expect(entries.slice(replayAt + 1).map((entry) => entry.message)).toEqual([
      "next question",
      { kind: "agent", markdown: "Next answer." },
    ]);
  });
});

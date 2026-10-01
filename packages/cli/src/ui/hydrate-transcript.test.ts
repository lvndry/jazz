/** Verifies atomic source-document restoration without rendered-text reconstruction. */
import type { ChatMessage } from "@jazz/core/types/message";
import type { PresentationEntry } from "@jazz/core/types/presentation-content";
import { describe, expect, test } from "bun:test";
import {
  hydrateInputHistoryFromMessages,
  hydrateTranscriptFromHistory,
  hydrateTranscriptFromUiEntries,
  presentationEntriesFromHistory,
} from "./hydrate-transcript";

function messages(list: readonly ChatMessage[]): readonly ChatMessage[] {
  return list;
}

describe("presentation history hydration", () => {
  test("restores source Markdown with deterministic per-document IDs", () => {
    const messages = [
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "**answer**" },
    ];
    const entries = presentationEntriesFromHistory(messages, "conversation:main");
    expect(entries.map((entry) => entry.content)).toEqual([
      { kind: "user", text: "question" },
      { kind: "agent", markdown: "**answer**" },
    ]);
    expect(entries).toEqual(presentationEntriesFromHistory(messages, "conversation:main"));
    expect(entries[0]?.id).not.toBe(presentationEntriesFromHistory(messages, "other:main")[0]?.id);
  });

  test("omits system, continuation, tool protocol, and empty assistant messages", () => {
    expect(
      presentationEntriesFromHistory(
        [
          { role: "system", content: "secret instructions" },
          { role: "user", content: "continue", kind: "continuation" },
          { role: "tool", content: "protocol", tool_call_id: "call" },
          { role: "assistant", content: "  " },
          { role: "user", content: "visible" },
        ],
        "main",
      ).map((entry) => entry.content),
    ).toEqual([{ kind: "user", text: "visible" }]);
  });

  test("replaces even an empty document in exactly one transaction", () => {
    const commits: { id: string; entries: readonly PresentationEntry[] }[] = [];
    hydrateTranscriptFromHistory([], "main", {
      replaceDocument: (id, entries) => commits.push({ id, entries }),
    });
    expect(commits).toEqual([{ id: "main", entries: [] }]);
  });
});

describe("hydrateInputHistoryFromMessages", () => {
  function historySink() {
    const state = { history: [] as string[], cleared: 0 };
    const sink = {
      history: state.history,
      get cleared() {
        return state.cleared;
      },
      pushInputHistory: (message: string) => state.history.push(message),
      clearInputHistory: () => {
        state.cleared += 1;
        state.history.length = 0;
      },
    };
    return sink;
  }

  test("seeds recall from user turns, newest last, skipping non-user and continuation messages", () => {
    const sink = historySink();
    hydrateInputHistoryFromMessages(
      messages([
        { role: "system", content: "persona only" },
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "  ", kind: "continuation" },
        { role: "user", content: "second question" },
      ]),
      sink,
    );

    expect(sink.cleared).toBe(1);
    expect(sink.history).toEqual(["first question", "second question"]);
  });

  test("empty history drops whatever recall was seeded before", () => {
    const sink = historySink();
    sink.pushInputHistory("leftover from the previous conversation");

    hydrateInputHistoryFromMessages([], sink);

    expect(sink.history).toEqual([]);
  });
});

describe("hydrateTranscriptFromUiEntries", () => {
  test("preserves saved IDs and receipt facts without restarting provider streams", () => {
    const entries: readonly PresentationEntry[] = [
      {
        id: "receipt",
        timestamp: "2026-08-01T10:00:00.000Z",
        content: {
          kind: "tool",
          receipt: { app: "read_file", summary: "README.md", status: "ok", durationMs: 123 },
        },
      },
      {
        id: "answer",
        timestamp: "2026-08-01T10:00:01.000Z",
        content: { kind: "agent", markdown: "partial answer" },
      },
    ];
    const commits: unknown[] = [];
    hydrateTranscriptFromUiEntries(entries, "main", {
      replaceDocument: (id, actual) => commits.push({ id, entries: actual }),
    });
    expect(commits).toEqual([{ id: "main", entries }]);
  });
});

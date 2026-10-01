import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, test } from "bun:test";
import {
  hydrateInputHistoryFromMessages,
  hydrateTranscriptFromHistory,
  hydrateTranscriptFromUiEntries,
  outputEntriesFromHistory,
  resolveSessionHydration,
} from "./hydrate-transcript";
import type { OutputEntry } from "./types";

function messages(list: readonly ChatMessage[]): readonly ChatMessage[] {
  return list;
}

describe("outputEntriesFromHistory", () => {
  test("maps user and assistant turns into the live transcript entry types", () => {
    const entries = outputEntriesFromHistory(
      messages([
        { role: "user", content: "Summarize yesterday's standup" },
        { role: "assistant", content: "The team shipped the resume fix." },
      ]),
    );

    expect(entries).toEqual([
      expect.objectContaining({ type: "user", message: "Summarize yesterday's standup" }),
      expect.objectContaining({
        type: "streamContent",
        message: "The team shipped the resume fix.",
      }),
    ]);
  });

  test("skips system, resume-banner, tool, and empty assistant messages", () => {
    const entries = outputEntriesFromHistory(
      messages([
        { role: "system", content: "You are a helpful agent." },
        {
          role: "system",
          content: "Resuming conversation from 8/22/2026, 2:00:00 PM: Standup notes",
        },
        { role: "user", content: "What next?" },
        { role: "assistant", content: "" },
        {
          role: "assistant",
          content: "   ",
          tool_calls: [
            { id: "call-1", type: "function", function: { name: "web", arguments: "{}" } },
          ],
        },
        { role: "tool", content: '{"ok":true}', tool_call_id: "call-1" },
        { role: "assistant", content: "Ship it." },
      ]),
    );

    expect(entries.map((entry) => entry.message)).toEqual(["What next?", "Ship it."]);
  });

  test("returns no entries for empty history", () => {
    expect(outputEntriesFromHistory([])).toEqual([]);
  });
});

describe("hydrateTranscriptFromHistory", () => {
  test("replaces the current transcript with saved user and assistant turns", () => {
    const printed: OutputEntry[] = [];
    let cleared = false;
    let flushed = false;

    hydrateTranscriptFromHistory(
      messages([
        { role: "system", content: "Resuming conversation from earlier: Standup notes" },
        { role: "user", content: "prior question" },
        { role: "assistant", content: "prior answer" },
      ]),
      {
        clearOutputs: () => {
          cleared = true;
          printed.length = 0;
        },
        printOutput: (entry) => {
          printed.push(entry);
          return "id";
        },
        flushOutputBatchNow: () => {
          flushed = true;
        },
      },
    );

    expect(cleared).toBe(true);
    expect(flushed).toBe(true);
    expect(printed.map((entry) => ({ type: entry.type, message: entry.message }))).toEqual([
      { type: "user", message: "prior question" },
      { type: "streamContent", message: "prior answer" },
    ]);
  });

  test("clears an existing transcript even when saved history has nothing visible", () => {
    const printed: OutputEntry[] = [];
    let cleared = false;

    hydrateTranscriptFromHistory(messages([{ role: "system", content: "persona only" }]), {
      clearOutputs: () => {
        cleared = true;
      },
      printOutput: (entry) => {
        printed.push(entry);
        return "id";
      },
      flushOutputBatchNow: () => undefined,
    });

    expect(cleared).toBe(true);
    expect(printed).toEqual([]);
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

describe("resolveSessionHydration", () => {
  const uiEntries = [{ type: "log" as const, message: "command output" }];
  const history = messages([{ role: "user", content: "real question" }]);

  test("prefers the UI transcript when present, but recall still reads the model history", () => {
    const plan = resolveSessionHydration(uiEntries, history);

    expect(plan.transcript).toBe("ui");
    // The plan repaints the UI entries…
    if (plan.transcript !== "ui") throw new Error("unreachable");
    expect(plan.entries).toBe(uiEntries);
    // …yet recall is seeded from the model history, so ↑ still recalls the turn.
    const sink = sinkFrom([]);
    hydrateInputHistoryFromMessages(history, sink);
    expect(sink.history).toEqual(["real question"]);
  });

  test("falls back to the model history when there is no UI transcript", () => {
    expect(resolveSessionHydration(undefined, history).transcript).toBe("history");
    expect(resolveSessionHydration([], history).transcript).toBe("history");
  });

  test("seeds nothing when the conversation is brand new", () => {
    expect(resolveSessionHydration(undefined, []).transcript).toBe("none");
    expect(resolveSessionHydration([], []).transcript).toBe("none");
  });
});

function sinkFrom(history: string[]) {
  const sink: {
    history: string[];
    pushInputHistory: (message: string) => void;
    clearInputHistory: () => void;
  } = { history, pushInputHistory: () => undefined, clearInputHistory: () => undefined };
  sink.pushInputHistory = (message) => sink.history.push(message);
  sink.clearInputHistory = () => {
    sink.history.length = 0;
  };
  return sink;
}

describe("hydrateTranscriptFromUiEntries", () => {
  test("restores command entries without manufacturing model messages", () => {
    const printed: OutputEntry[] = [];
    hydrateTranscriptFromUiEntries(
      [
        { type: "user", message: "/info" },
        { type: "log", message: "Conversation info" },
      ],
      {
        clearOutputs: () => undefined,
        printOutput: (entry) => {
          printed.push(entry);
          return "id";
        },
        flushOutputBatchNow: () => undefined,
      },
    );
    expect(printed.map((entry) => ({ type: entry.type, message: entry.message }))).toEqual([
      { type: "user", message: "/info" },
      { type: "log", message: "Conversation info" },
    ]);
  });
});

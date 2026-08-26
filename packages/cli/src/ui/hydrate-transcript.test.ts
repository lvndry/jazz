import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, test } from "bun:test";
import { hydrateTranscriptFromHistory, outputEntriesFromHistory } from "./hydrate-transcript";
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

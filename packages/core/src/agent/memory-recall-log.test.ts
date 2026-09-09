import { describe, test, expect } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import {
  analyzeMemoryRecall,
  summarizeMemoryRecalls,
  type MemoryRecallEntry,
} from "./memory-recall-log";

function assistantToolCall(name: string): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: "{}" } }],
  };
}

function toolResult(): ChatMessage {
  return { role: "tool", content: "ok", tool_call_id: "call-view_memory" };
}

function answer(content = "Here you go."): ChatMessage {
  return { role: "assistant", content };
}

describe("analyzeMemoryRecall", () => {
  test("counts a view that lands before the first answer", () => {
    const observation = analyzeMemoryRecall(
      [{ role: "user", content: "hey" }, assistantToolCall("view_memory"), toolResult(), answer()],
      true,
    );
    expect(observation.viewedBeforeFirstAnswer).toBe(true);
    expect(observation.viewCallCount).toBe(1);
    expect(observation.writeCallCount).toBe(0);
  });

  test("counts a view that lands only after the first answer as a miss", () => {
    const observation = analyzeMemoryRecall(
      [
        { role: "user", content: "hey" },
        answer(),
        { role: "user", content: "actually, remember I use bun" },
        assistantToolCall("view_memory"),
        toolResult(),
      ],
      true,
    );
    expect(observation.viewedBeforeFirstAnswer).toBe(false);
    expect(observation.viewCallCount).toBe(1);
  });

  test("reports a miss when memory is never consulted", () => {
    const observation = analyzeMemoryRecall([{ role: "user", content: "hey" }, answer()], true);
    expect(observation.viewedBeforeFirstAnswer).toBe(false);
    expect(observation.viewCallCount).toBe(0);
  });

  test("a run that never answers still counts a view as in time", () => {
    const observation = analyzeMemoryRecall(
      [{ role: "user", content: "hey" }, assistantToolCall("view_memory"), toolResult()],
      true,
    );
    expect(observation.viewedBeforeFirstAnswer).toBe(true);
  });

  test("ignores an empty assistant turn when locating the first answer", () => {
    const observation = analyzeMemoryRecall(
      [
        { role: "user", content: "hey" },
        { role: "assistant", content: "   " },
        assistantToolCall("view_memory"),
        toolResult(),
        answer(),
      ],
      true,
    );
    expect(observation.viewedBeforeFirstAnswer).toBe(true);
  });

  test("does not treat a compaction summary as the first answer", () => {
    const observation = analyzeMemoryRecall(
      [
        { role: "user", content: "hey" },
        { role: "assistant", content: "earlier context", kind: "summary" },
        assistantToolCall("view_memory"),
        toolResult(),
        answer(),
      ],
      true,
    );
    expect(observation.viewedBeforeFirstAnswer).toBe(true);
  });

  test("counts writes separately from views", () => {
    const observation = analyzeMemoryRecall(
      [
        { role: "user", content: "I use bun" },
        assistantToolCall("view_memory"),
        toolResult(),
        assistantToolCall("manage_memory"),
        toolResult(),
        assistantToolCall("manage_memory"),
        toolResult(),
        answer(),
      ],
      true,
    );
    expect(observation.viewCallCount).toBe(1);
    expect(observation.writeCallCount).toBe(2);
  });

  test("records whether the tools were offered at all", () => {
    expect(analyzeMemoryRecall([answer()], false).memoryToolsOffered).toBe(false);
    expect(analyzeMemoryRecall([answer()], true).memoryToolsOffered).toBe(true);
  });
});

describe("summarizeMemoryRecalls", () => {
  function entry(
    surface: string,
    viewedBeforeFirstAnswer: boolean,
    memoryToolsOffered = true,
  ): MemoryRecallEntry {
    return {
      timestamp: "2026-09-08T00:00:00.000Z",
      surface,
      agentId: "agent-1",
      memoryToolsOffered,
      viewedBeforeFirstAnswer,
      viewCallCount: viewedBeforeFirstAnswer ? 1 : 0,
      writeCallCount: 0,
    };
  }

  test("reports a rate per surface", () => {
    const rates = summarizeMemoryRecalls([
      entry("cli", true),
      entry("cli", true),
      entry("telegram", false),
      entry("telegram", false),
      entry("telegram", true),
    ]);
    expect(rates).toEqual([
      { surface: "cli", eligibleRuns: 2, viewedBeforeFirstAnswer: 2, rate: 1 },
      { surface: "telegram", eligibleRuns: 3, viewedBeforeFirstAnswer: 1, rate: 1 / 3 },
    ]);
  });

  test("excludes runs that were never offered the tools from the denominator", () => {
    const rates = summarizeMemoryRecalls([
      entry("cli", true),
      entry("cli", false, false),
      entry("cli", false, false),
    ]);
    expect(rates).toEqual([
      { surface: "cli", eligibleRuns: 1, viewedBeforeFirstAnswer: 1, rate: 1 },
    ]);
  });
});

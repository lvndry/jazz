import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import { closeUnansweredToolCalls } from "./unanswered-tool-calls";

function call(id: string, name = "execute_command") {
  return { id, type: "function" as const, function: { name, arguments: "{}" } };
}

const CLOSED = "no result";

describe("closeUnansweredToolCalls", () => {
  it("returns the same array when every call has an answer", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [call("a")] },
      { role: "tool", content: "ok", tool_call_id: "a" },
    ];

    expect(closeUnansweredToolCalls(messages, CLOSED)).toBe(messages);
  });

  /**
   * The shape a parked run leaves when its resume fails: the saved conversation ends on
   * the assistant turn that asked for approval, and the next run's provider call rejects it.
   */
  it("answers a parked tail whose calls never returned", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "continue" },
      { role: "assistant", content: "checking", tool_calls: [call("a", "stat"), call("b")] },
    ];

    expect(closeUnansweredToolCalls(messages, CLOSED)).toEqual([
      ...messages,
      { role: "tool", name: "stat", content: CLOSED, tool_call_id: "a" },
      { role: "tool", name: "execute_command", content: CLOSED, tool_call_id: "b" },
    ]);
  });

  it("places answers directly after the call's existing results, not at the end", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
      { role: "tool", content: "ok", tool_call_id: "a" },
      { role: "user", content: "next question" },
      { role: "assistant", content: "answer" },
    ];

    expect(closeUnansweredToolCalls(messages, CLOSED)).toEqual([
      messages[0]!,
      messages[1]!,
      { role: "tool", name: "execute_command", content: CLOSED, tool_call_id: "b" },
      messages[2]!,
      messages[3]!,
    ]);
  });

  it("leaves the input untouched", () => {
    const messages: ChatMessage[] = [{ role: "assistant", content: "", tool_calls: [call("a")] }];

    closeUnansweredToolCalls(messages, CLOSED);

    expect(messages).toHaveLength(1);
  });
});

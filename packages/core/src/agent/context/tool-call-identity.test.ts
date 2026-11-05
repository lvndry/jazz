import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import { repairToolCallIdentities } from "./tool-call-identity";
import { closeUnansweredToolCalls } from "./unanswered-tool-calls";

function call(id: string, name: string) {
  return { id, type: "function" as const, function: { name, arguments: "{}" } };
}

describe("repairToolCallIdentities", () => {
  it("returns the same array when every call has an id and a name", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", tool_calls: [call("a", "grep")] },
      { role: "tool", content: "ok", tool_call_id: "a", name: "grep" },
    ];
    const repair = repairToolCallIdentities(messages);
    expect(repair.messages).toBe(messages);
    expect(repair.repairedCalls).toBe(0);
  });

  it("gives an empty-id call a positional id and pairs the idless result with it", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [call("", "grep"), call("b", "ls")] },
      { role: "tool", content: "one", tool_call_id: "", name: "" },
      { role: "tool", content: "two", tool_call_id: "b", name: "ls" },
    ];
    const repair = repairToolCallIdentities(messages, (_message, index) => `m${index}`);
    expect(repair.repairedCalls).toBe(1);
    expect(repair.pairedResults).toBe(1);
    expect(repair.messages[1]?.tool_calls?.map((entry) => entry.id)).toEqual([
      "repaired-m1-0",
      "b",
    ]);
    expect(repair.messages[2]?.tool_call_id).toBe("repaired-m1-0");
    expect(repair.messages[2]?.name).toBe("grep");
    expect(messages[1]?.tool_calls?.[0]?.id).toBe("");
  });

  it("names a call that lost its name and keeps its id", () => {
    const repair = repairToolCallIdentities([
      { role: "assistant", content: "", tool_calls: [call("a", "")] },
      { role: "tool", content: "ok", tool_call_id: "a", name: "" },
    ]);
    expect(repair.messages[0]?.tool_calls?.[0]).toMatchObject({
      id: "a",
      function: { name: "unknown_tool" },
    });
  });

  it("leaves an unanswered empty-id call for the closing logic to answer", () => {
    const repair = repairToolCallIdentities([
      { role: "assistant", content: "", tool_calls: [call("", "grep")] },
    ]);
    const closed = closeUnansweredToolCalls(repair.messages, "interrupted");
    expect(closed).toHaveLength(2);
    expect(closed[1]?.tool_call_id).toBe(repair.messages[0]?.tool_calls?.[0]?.id);
  });
});

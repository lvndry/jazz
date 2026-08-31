import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import { clearToolResults, toolResultsProtectFromIndex } from "./tool-result-clearing";

const modelHint = { provider: "openai", modelId: "gpt-4o" };

const fixedCounter = {
  countMessage: (message: ChatMessage) => Math.ceil((message.content?.length ?? 0) / 4),
  countMessages: (messages: readonly ChatMessage[]) =>
    messages.reduce((total, message) => total + Math.ceil((message.content?.length ?? 0) / 4), 0),
} as any;

function bigResult(callId: string): ChatMessage {
  return { role: "tool", tool_call_id: callId, content: "x".repeat(20_000) } as ChatMessage;
}

function assistantCall(callId: string, toolName: string): ChatMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: toolName, arguments: "{}" } }],
  } as ChatMessage;
}

/** system + N (assistant call, tool result) pairs + a trailing user turn. */
function conversation(pairs: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system" }];
  for (let index = 0; index < pairs; index++) {
    messages.push({ role: "user", content: `ask ${index}` });
    messages.push(assistantCall(`call_${index}`, "read_file"));
    messages.push(bigResult(`call_${index}`));
  }
  return messages;
}

describe("toolResultsProtectFromIndex", () => {
  it("protects the live tool cycle so the model still sees what it just asked for", () => {
    const messages = conversation(3);
    const protectFrom = toolResultsProtectFromIndex(messages);
    const lastCall = messages.findLastIndex((message) => message.role === "assistant");
    expect(protectFrom).toBe(lastCall);
  });

  it("protects nothing once a later assistant message has consumed the cycle", () => {
    const messages = [
      ...conversation(2),
      { role: "assistant", content: "here is the answer" } as ChatMessage,
    ];
    expect(toolResultsProtectFromIndex(messages)).toBe(messages.length);
  });
});

describe("clearToolResults", () => {
  it("replaces old large results with a placeholder while keeping the message", () => {
    const messages = conversation(10);
    const outcome = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });

    expect(outcome.clearedCount).toBeGreaterThan(0);
    expect(outcome.tokensReclaimed).toBeGreaterThan(0);

    const clearedMessages = outcome.messages.filter((message) => message.cleared);
    for (const message of clearedMessages) {
      expect(message.role).toBe("tool");
      expect(message.tool_call_id).toBeDefined();
      expect(message.content).toContain("tool result cleared");
      expect(message.content).toContain("read_file");
    }
  });

  it("points at retrieve_tool_result when the body was persisted", () => {
    const messages = conversation(4);
    const outcome = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
      retrievableIds: new Set(["call_0", "call_1"]),
    });

    const call0 = outcome.messages.find((message) => message.tool_call_id === "call_0");
    expect(call0?.content).toContain("retrieve_tool_result");
    expect(call0?.content).toContain("call_0");
    const call2 = outcome.messages.find((message) => message.tool_call_id === "call_2");
    expect(call2?.content).toContain("Re-run the tool");
  });

  it("never orphans a tool result from its assistant call", () => {
    const messages = conversation(10);
    const outcome = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });

    const toolCallIds = new Set(
      outcome.messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
    );
    for (const message of outcome.messages) {
      if (message.role === "tool" && message.tool_call_id) {
        expect(toolCallIds.has(message.tool_call_id)).toBe(true);
      }
    }
    expect(outcome.messages.length).toBe(messages.length);
  });

  it("leaves the live tool cycle untouched", () => {
    const messages = conversation(10);
    const protectedFromIndex = toolResultsProtectFromIndex(messages);
    const outcome = clearToolResults(messages, {
      protectedFromIndex,
      modelHint,
      tokenCounter: fixedCounter,
    });

    for (let index = protectedFromIndex; index < outcome.messages.length; index++) {
      expect(outcome.messages[index]?.cleared).toBeUndefined();
    }
    expect(outcome.clearedCount).toBeGreaterThan(0);
  });

  it("ignores results below the size floor", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system" },
      ...Array.from({ length: 12 }, (_, index) => [
        { role: "user", content: `ask ${index}` } as ChatMessage,
        assistantCall(`call_${index}`, "grep"),
        { role: "tool", tool_call_id: `call_${index}`, content: "tiny" } as ChatMessage,
      ]).flat(),
    ];

    const outcome = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });

    expect(outcome.clearedCount).toBe(0);
    expect(outcome.tokensReclaimed).toBe(0);
  });

  it("is idempotent — a second pass clears nothing new", () => {
    const messages = conversation(12);
    const first = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });
    const second = clearToolResults(first.messages, {
      protectedFromIndex: first.messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });

    expect(first.clearedCount).toBeGreaterThan(0);
    expect(second.clearedCount).toBe(0);
  });

  it("returns the same array reference when nothing qualifies", () => {
    const tiny: ChatMessage[] = [
      { role: "system", content: "system" },
      assistantCall("call_tiny", "grep"),
      { role: "tool", tool_call_id: "call_tiny", content: "tiny" } as ChatMessage,
    ];
    const outcome = clearToolResults(tiny, {
      protectedFromIndex: tiny.length,
      modelHint,
      tokenCounter: fixedCounter,
    });
    expect(outcome.clearedCount).toBe(0);
    expect(outcome.messages).toBe(tiny);
  });
});

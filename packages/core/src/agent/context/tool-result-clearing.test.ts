import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import { clearToolResults, KEEP_RECENT_TOOL_RESULTS } from "./tool-result-clearing";

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

  it("keeps the most recent results verbatim", () => {
    const messages = conversation(10);
    const outcome = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });

    const results = outcome.messages.filter((message) => message.role === "tool");
    const recent = results.slice(-KEEP_RECENT_TOOL_RESULTS);
    for (const message of recent) {
      expect(message.cleared).toBeUndefined();
    }
  });

  it("leaves the protected zone untouched", () => {
    const messages = conversation(10);
    const protectedFromIndex = messages.length - 6;
    const outcome = clearToolResults(messages, {
      protectedFromIndex,
      modelHint,
      tokenCounter: fixedCounter,
    });

    for (let index = protectedFromIndex; index < outcome.messages.length; index++) {
      expect(outcome.messages[index]?.cleared).toBeUndefined();
    }
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

  it("does nothing when there are too few results to spare any", () => {
    const messages = conversation(3);
    const outcome = clearToolResults(messages, {
      protectedFromIndex: messages.length,
      modelHint,
      tokenCounter: fixedCounter,
    });

    expect(outcome.clearedCount).toBe(0);
  });
});

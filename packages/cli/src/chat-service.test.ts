import { createEgressTaint } from "@jazz/core/agent/execution/egress-taint";
import { LLMRequestError } from "@jazz/core/types/errors";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import { capChatHistory, exhaustedRetryLines } from "./chat-service";

describe("capChatHistory", () => {
  it("keeps the newest messages and the taint of the ones it drops", () => {
    const history: ChatMessage[] = [
      { role: "tool", tool_call_id: "fetch", content: "[cleared]", egressTainted: true },
      { role: "assistant", content: "summary of the page" },
      { role: "user", content: "next question" },
      { role: "assistant", content: "answer" },
    ];

    const capped = capChatHistory(history, 2);

    expect(capped.map((message) => message.content)).toEqual(["next question", "answer"]);
    expect(createEgressTaint(capped).isTainted()).toBe(true);
  });

  it("returns the history as it is when it is under the cap", () => {
    const history: ChatMessage[] = [{ role: "user", content: "hi" }];
    expect(capChatHistory(history, 2)).toEqual(history);
  });
});

describe("exhaustedRetryLines", () => {
  const texts = (error: LLMRequestError) =>
    exhaustedRetryLines(error, error.message).map((line) => line.text);

  it("does not blame the network when the provider answered with an unreadable response", () => {
    const lines = texts(
      new LLMRequestError({
        provider: "vllm",
        message: "Failed to process successful response",
        unreadableResponse: true,
      }),
    );
    expect(lines[0]).toStartWith("The provider answered, but Jazz couldn't read its response");
    expect(lines.join("\n")).not.toContain("network");
  });

  it("does not blame the network for a server error", () => {
    const lines = texts(
      new LLMRequestError({ provider: "openai", message: "Server error (503)", statusCode: 503 }),
    );
    expect(lines[0]).toStartWith("The LLM API kept failing");
    expect(lines.join("\n")).not.toContain("network");
  });

  it("points at connectivity when no response arrived", () => {
    const lines = texts(new LLMRequestError({ provider: "openai", message: "fetch failed" }));
    expect(lines[0]).toStartWith("Could not reach the LLM API");
    expect(lines[1]).toContain("network");
  });
});

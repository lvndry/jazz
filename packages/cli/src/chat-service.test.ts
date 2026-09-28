import { createEgressTaint } from "@jazz/core/agent/execution/egress-taint";
import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, it } from "bun:test";
import { capChatHistory } from "./chat-service";

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

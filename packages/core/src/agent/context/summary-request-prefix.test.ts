/** Verify manual checkpoint boundaries without splitting tool groups or changing media projection. */
import { describe, expect, it } from "bun:test";
import type { ConversationMessages } from "../../types/message";
import { summaryRequestPrefix } from "./summarizer";

function history(): ConversationMessages {
  return [
    { role: "system", content: "rules" },
    { role: "user", content: "older task" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "first", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "second", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "second", content: "second result" },
    { role: "tool", tool_call_id: "first", content: "first result" },
    { role: "user", content: "recent task kept verbatim" },
    { role: "assistant", content: "recent answer" },
  ];
}

describe("summaryRequestPrefix", () => {
  it("extends a split through all outstanding parallel tool results and omits the recent tail", () => {
    const messages = history();
    const result = summaryRequestPrefix(messages, messages.slice(1, 3));

    expect(result?.history).toEqual([messages[0], ...messages.slice(1, 5)]);
    expect(result?.startsNewTurn).toBe(true);
    expect(result?.history[2]).toBe(messages[2]);
    expect(messages).toHaveLength(7);
  });

  it("stops at a complete boundary without including later turns", () => {
    const messages = history();
    const result = summaryRequestPrefix(messages, messages.slice(1, 5));
    expect(result?.history).toEqual([messages[0], ...messages.slice(1, 5)]);
  });

  it("preserves current-turn reasoning when the prefix contains the latest real user message", () => {
    const original = history();
    const messages: ConversationMessages = [
      original[0],
      ...original.slice(1, 5),
      { role: "assistant", content: "recent final answer" },
      { role: "user", kind: "ephemeral", content: "pressure nudge" },
    ];
    expect(summaryRequestPrefix(messages, messages.slice(1, 3))?.startsNewTurn).toBe(false);
  });

  it("rejects a prefix whose tool result never arrives", () => {
    const original = history();
    const messages: ConversationMessages = [original[0], ...original.slice(1, 4)];
    expect(summaryRequestPrefix(messages, messages.slice(1, 3))).toBeUndefined();
  });

  it("falls back for attachments instead of changing which images are inlined", () => {
    const messages = history();
    messages.push({
      role: "user",
      content: "recent image",
      attachments: [
        { kind: "image", path: "/tmp/image.png", mediaType: "image/png", byteSize: 100 },
      ],
    });
    expect(summaryRequestPrefix(messages, messages.slice(1, 3))).toBeUndefined();
  });

  it("rejects a target outside the observed history", () => {
    expect(
      summaryRequestPrefix(history(), [{ role: "user", content: "unrelated" }]),
    ).toBeUndefined();
    expect(summaryRequestPrefix(history(), [])).toBeUndefined();
  });
});

/**
 * Token accounting for attachments.
 *
 * The bug this guards against: attachments contribute zero characters, so a conversation full of
 * screenshots estimates as small while the real request overflows the context window — and the
 * compaction ladder never fires. The second, subtler failure is the estimator disagreeing with
 * request assembly about *which* attachments are still being sent.
 */

import { describe, expect, it } from "bun:test";
import type { MessageAttachment } from "@/core/types/attachment";
import type { ChatMessage } from "@/core/types/message";
import { TokenCounter } from "./token-counter";

const hint = { provider: "anthropic", modelId: "claude-sonnet-4" };

function image(path: string): MessageAttachment {
  return {
    kind: "image",
    mediaType: "image/png",
    path,
    byteSize: 2048,
    width: 1000,
    height: 1000,
  };
}

describe("TokenCounter with attachments", () => {
  it("counts an attachment that carries no characters", () => {
    const counter = new TokenCounter();
    const withoutAttachment: ChatMessage = { role: "user", content: "look at this" };
    const withAttachment: ChatMessage = {
      role: "user",
      content: "look at this",
      attachments: [image("/tmp/a.png")],
    };

    const plain = counter.countMessages([withoutAttachment], hint);
    const attached = counter.countMessages([withAttachment], hint);
    expect(attached).toBeGreaterThan(plain + 1_000);
  });

  it("does not let several images hide inside a small character count", () => {
    const counter = new TokenCounter();
    const messages: ChatMessage[] = [
      { role: "user", content: "a", attachments: [image("/tmp/a.png")] },
    ];
    // Four characters of text, but a real request in the thousands of tokens.
    expect(counter.countMessages(messages, hint)).toBeGreaterThan(1_000);
  });

  it("stops charging full price once an attachment ages out of the inline window", () => {
    const counter = new TokenCounter();
    const aged: ChatMessage[] = [
      { role: "user", content: "first", attachments: [image("/tmp/old.png")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third" },
    ];
    const inWindow: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third", attachments: [image("/tmp/old.png")] },
    ];

    // Same attachment, same text, different position: only the in-window one is billed in full.
    expect(counter.countMessages(aged, hint)).toBeLessThan(counter.countMessages(inWindow, hint));
  });

  it("still charges the aged-out attachment for its text description", () => {
    const counter = new TokenCounter();
    const withAged: ChatMessage[] = [
      { role: "user", content: "first", attachments: [image("/tmp/old.png")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third" },
    ];
    const withNothing: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "third" },
    ];
    // The description replaces the file, so the cost drops but does not vanish.
    expect(counter.countMessages(withAged, hint)).toBeGreaterThan(
      counter.countMessages(withNothing, hint),
    );
  });

  it("counts a standalone message as if its attachment were sent", () => {
    // countMessage has no positional information, so it prices attachments as present. Callers
    // that know the position (countMessages) refine that.
    const counter = new TokenCounter();
    const message: ChatMessage = {
      role: "user",
      content: "hi",
      attachments: [image("/tmp/a.png")],
    };
    expect(counter.countMessage(message, hint)).toBeGreaterThan(1_000);
  });

  it("leaves attachment-free counting unchanged", () => {
    const counter = new TokenCounter();
    const messages: ChatMessage[] = [
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const total = counter.countMessages(messages, hint);
    const sum = messages.reduce((acc, message) => acc + counter.countMessage(message, hint), 0);
    expect(total).toBe(sum);
  });
});

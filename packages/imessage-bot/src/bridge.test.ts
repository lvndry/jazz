import { isJazzBinaryPath } from "@jazz/bot-shared/jazz-binary";
import { describe, expect, test } from "bun:test";
import { createCursorTracker, promptFrom, questionFromSelfText } from "./bridge";

describe("isJazzBinaryPath", () => {
  test("recognises the npm-installed binary", () => {
    expect(isJazzBinaryPath("/Users/me/.bun/bin/jazz")).toBe(true);
  });

  test("recognises a locally built one, which build:binary names per target", () => {
    expect(isJazzBinaryPath("/repo/deploy/binaries/jazz-darwin-arm64")).toBe(true);
    expect(isJazzBinaryPath("/repo/deploy/binaries/jazz-linux-x64-musl")).toBe(true);
  });

  test("does not mistake bun for it, which cannot run a turn", () => {
    expect(isJazzBinaryPath("/Users/me/.bun/bin/bun")).toBe(false);
  });

  test("is not fooled by a directory called jazz", () => {
    expect(isJazzBinaryPath("/Users/me/jazz/node_modules/.bin/bun")).toBe(false);
  });
});

describe("questionFromSelfText", () => {
  test("takes the question after the trigger", () => {
    expect(questionFromSelfText("jazz what time is it", "jazz")).toBe("what time is it");
  });

  test("ignores case and surrounding space, as Messages leaves both", () => {
    expect(questionFromSelfText("  Jazz  what time is it  ", "jazz")).toBe("what time is it");
  });

  test("ignores a message that does not open with the trigger", () => {
    expect(questionFromSelfText("what time is it", "jazz")).toBeUndefined();
  });

  test("ignores the bare trigger, which asks nothing", () => {
    expect(questionFromSelfText("jazz", "jazz")).toBeUndefined();
  });

  test("stays silent when no trigger is configured", () => {
    expect(questionFromSelfText("jazz what time is it", undefined)).toBeUndefined();
  });
});

describe("promptFrom", () => {
  const message = {
    id: 1,
    chatId: 7,
    sender: "me@example.com",
    text: "jazz what time is it",
    isFromMe: true,
    isReaction: false,
    attachments: [],
    replyToText: "https://example.com/thing",
  } as unknown as Parameters<typeof promptFrom>[0];

  test("keeps the quoted context around the question, so a reply still has it", () => {
    expect(promptFrom(message, "what time is it")).toBe(
      "[replying to: https://example.com/thing]\nwhat time is it",
    );
  });

  test("a reply no longer hides the trigger from the match", () => {
    // The bug: the trigger was tested against this composed string, which
    // starts with the quote, so every reply was silently dropped.
    expect(questionFromSelfText(promptFrom(message), "jazz")).toBeUndefined();
    expect(questionFromSelfText(message.text, "jazz")).toBe("what time is it");
  });
});

describe("the self trigger is a word", () => {
  test("a word that only starts with the trigger is not a question", () => {
    expect(questionFromSelfText("jazzy weather today", "jazz")).toBeUndefined();
    expect(questionFromSelfText("Jazz, what's up", "jazz")).toBe("what's up");
    expect(questionFromSelfText("jazz: remind me", "jazz")).toBe("remind me");
  });
});

describe("createCursorTracker", () => {
  test("moves only past messages that were handled", () => {
    const cursor = createCursorTracker();
    cursor.started(10);
    cursor.started(11);
    // 11 finished first, but 10 is still open: resume from before 10.
    expect(cursor.finished(11)).toBe(9);
    expect(cursor.finished(10)).toBe(11);
  });
});

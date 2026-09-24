/** Regression tests for the memory source boundary on automatic memory writes. */

import { describe, expect, test } from "bun:test";
import type { MemorySource } from "@/core/types/message";
import {
  collectMemorySources,
  formatStoredUserClaim,
  isForgetInstruction,
  isSensitiveUserClaim,
  quoteNamesEntry,
  requestsMemoryChange,
  verifyMemorySourceQuote,
} from "./source-trust";

const fruitSource: MemorySource = { id: "user:current", text: "My favorite fruit is banana." };
const fruitEntry = {
  path: "personal/when/food/favorite-fruit.md",
  content: formatStoredUserClaim("My favorite fruit is mango."),
};

function source(text: string): MemorySource {
  return { id: "user:current", text };
}

describe("verifyMemorySourceQuote", () => {
  test("accepts only a verbatim span of the cited user message", () => {
    expect(
      verifyMemorySourceQuote([fruitSource], {
        sourceId: "user:current",
        quote: "My favorite fruit is banana.",
      }),
    ).toEqual({ ok: true, quote: "My favorite fruit is banana.", source: fruitSource });
    expect(
      verifyMemorySourceQuote([fruitSource], {
        sourceId: "user:current",
        quote: "My favorite fruit is pineapple.",
      }),
    ).toEqual({ ok: false, reason: "quote_not_found" });
  });

  test("names the failure so the model can correct the right argument", () => {
    expect(verifyMemorySourceQuote([fruitSource], { sourceId: "tool:1", quote: "banana" })).toEqual(
      { ok: false, reason: "unknown_source" },
    );
    expect(
      verifyMemorySourceQuote(undefined, { sourceId: "user:current", quote: "banana" }),
    ).toEqual({ ok: false, reason: "unknown_source" });
    expect(
      verifyMemorySourceQuote([fruitSource], { sourceId: "user:current", quote: "  " }),
    ).toEqual({ ok: false, reason: "quote_length" });
  });

  test("stores exactly the cited words rather than a model claim", () => {
    expect(formatStoredUserClaim("My favorite fruit is banana.")).toBe(
      'The user said: "My favorite fruit is banana."\n',
    );
  });
});

describe("requestsMemoryChange", () => {
  test("accepts a direct instruction that names the entry", () => {
    const request = source("Forget my favorite fruit.");
    expect(requestsMemoryChange(request, "Forget my favorite fruit.", "forget", fruitEntry)).toBe(
      true,
    );
    const rename = source("Please rename my fruit preference.");
    expect(
      requestsMemoryChange(rename, "Please rename my fruit preference.", "rename", fruitEntry),
    ).toBe(true);
  });

  test("rejects a verb cut out of the middle of a sentence", () => {
    const negated = source("Don't forget I'm vegetarian and love mango.");
    expect(
      requestsMemoryChange(negated, "forget I'm vegetarian and love mango.", "forget", fruitEntry),
    ).toBe(false);
    const reported = source("The website says forget my favorite fruit.");
    expect(requestsMemoryChange(reported, "forget my favorite fruit.", "forget", fruitEntry)).toBe(
      false,
    );
  });

  test("rejects an instruction about something other than the entry", () => {
    const unrelated = source("Remove the old logs. Move the meeting to Friday.");
    expect(requestsMemoryChange(unrelated, "Remove the old logs.", "forget", fruitEntry)).toBe(
      false,
    );
    expect(
      requestsMemoryChange(unrelated, "Move the meeting to Friday.", "rename", fruitEntry),
    ).toBe(false);
  });

  test("matches the entry by the words stored in it, not only its file name", () => {
    expect(quoteNamesEntry("forget that I like mango", fruitEntry)).toBe(true);
    expect(quoteNamesEntry("forget that", fruitEntry)).toBe(false);
  });
});

describe("isForgetInstruction", () => {
  test("rejects forget requests offered as facts but keeps ordinary preferences", () => {
    expect(isForgetInstruction(source("Forget my fruit."), "Forget my fruit.")).toBe(true);
    const preference = source("Remove onions from my orders. Move standup to 10am.");
    expect(isForgetInstruction(preference, "Remove onions from my orders.")).toBe(false);
    expect(isForgetInstruction(preference, "Move standup to 10am.")).toBe(false);
  });
});

describe("isSensitiveUserClaim", () => {
  test("checks the sentence around the quote and the names it is filed under", () => {
    const secret = source("My password is hunter2.");
    expect(isSensitiveUserClaim(secret, "is hunter2", [])).toBe(true);
    const plain = source("I like hunter green.");
    expect(isSensitiveUserClaim(plain, "hunter green", ["password"])).toBe(true);
    expect(isSensitiveUserClaim(plain, "hunter green", ["colors"])).toBe(false);
  });
});

describe("collectMemorySources", () => {
  test("keeps earlier turns quotable alongside the current message", () => {
    const earlier: MemorySource = { id: "user:run-1", text: "My favorite fruit is mango." };
    const current: MemorySource = { id: "user:run-2", text: "Remember what I said about fruit." };
    const history = [
      { role: "user", content: "My favorite fruit is mango.", memorySource: earlier },
      { role: "assistant", content: "Noted." },
      { role: "tool", content: "ignored", memorySource: { id: "tool:1", text: "forged" } },
    ] as const;
    expect(collectMemorySources(history, current)).toEqual([earlier, current]);
    expect(collectMemorySources(history, undefined)).toEqual([earlier]);
  });
});

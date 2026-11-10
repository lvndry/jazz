import { describe, expect, test } from "bun:test";
import { TOPIC_NAME_LIMIT, topicNameFrom } from "./topic-names";

/** Half of an emoji's UTF-16 pair with its other half cut away. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("topicNameFrom", () => {
  test("a short message is the name as written", () => {
    expect(topicNameFrom("Plan the Lisbon trip")).toBe("Plan the Lisbon trip");
  });

  test("line breaks and runs of spaces collapse, since a name is one line", () => {
    expect(topicNameFrom("  Plan\n\nthe   trip ")).toBe("Plan the trip");
  });

  test("a long message is cut on a whole word and marked as cut", () => {
    const name = topicNameFrom(
      "Can you help me figure out how much I should set aside for taxes this quarter",
    );
    expect(name).toBe("Can you help me figure out how much I should…");
  });

  test("one unbroken run is cut mid-word instead of leaving nothing", () => {
    const name = topicNameFrom("x".repeat(300));
    expect(name?.endsWith("…")).toBe(true);
    expect(name?.length).toBeLessThanOrEqual(TOPIC_NAME_LIMIT);
  });

  test("a cut never splits an emoji, even one built from several joined parts", () => {
    for (const emoji of ["🎉", "👨‍👩‍👧‍👦", "🇫🇷"]) {
      const name = topicNameFrom(`${"a".repeat(47)}${emoji} and more words after it`) ?? "";
      expect(LONE_SURROGATE.test(name)).toBe(false);
      expect(name).toBe(`${"a".repeat(47)}${emoji}…`);
    }
  });

  test("a name of many long emoji still fits Telegram's limit", () => {
    const name = topicNameFrom("👨‍👩‍👧‍👦".repeat(60)) ?? "";
    expect(name.length).toBeLessThanOrEqual(TOPIC_NAME_LIMIT);
    expect(LONE_SURROGATE.test(name)).toBe(false);
    expect(name.endsWith("👨‍👩‍👧‍👦…")).toBe(true);
  });

  test("a message with no words gives no name", () => {
    expect(topicNameFrom("   \n ")).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { TOPIC_NAME_LIMIT, topicNameFrom } from "./topic-names";

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

  test("a message with no words gives no name", () => {
    expect(topicNameFrom("   \n ")).toBeUndefined();
  });
});

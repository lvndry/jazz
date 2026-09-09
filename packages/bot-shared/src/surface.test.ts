import { describe, expect, test } from "bun:test";
import {
  bold,
  type Choice,
  code,
  codeBlock,
  line,
  matchChoice,
  plainLine,
  quote,
  renderChoicesAsText,
  renderPlain,
  splitForSurface,
  text,
} from "./surface";

describe("renderPlain", () => {
  test("drops every mark and keeps the words", () => {
    expect(renderPlain([line(bold("Working"), text(" — "), code("web_search"))])).toBe(
      "Working — web_search",
    );
  });

  test("prefixes quote rows so a quote still reads as one", () => {
    expect(renderPlain([quote("first\nsecond")])).toBe("> first\n> second");
  });

  test("joins blocks with newlines", () => {
    expect(renderPlain([plainLine("a"), codeBlock("b()"), plainLine("c")])).toBe("a\nb()\nc");
  });
});

describe("splitForSurface", () => {
  test("leaves a message under the limit alone", () => {
    expect(splitForSurface("short", 100)).toEqual(["short"]);
  });

  test("prefers a paragraph break over a line break", () => {
    const body = `${"a".repeat(40)}\n\n${"b".repeat(40)}\nmore`;
    const chunks = splitForSurface(body, 50);
    expect(chunks[0]).toBe("a".repeat(40));
    expect(chunks[1]).toBe(`${"b".repeat(40)}\nmore`);
  });

  test("cuts mid-word only when one word exceeds the limit", () => {
    const chunks = splitForSurface("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  test("every chunk stays within the limit", () => {
    const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    for (const chunk of splitForSurface(body, 120)) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });

  test("loses no words across the split", () => {
    const body = Array.from({ length: 200 }, (_, index) => `word${index}`).join(" ");
    expect(splitForSurface(body, 120).join(" ").split(/\s+/)).toEqual(body.split(" "));
  });
});

describe("matchChoice", () => {
  const choices: readonly Choice[] = [
    { id: "yes", label: "Accept" },
    { id: "no", label: "Reject" },
  ];

  test("matches by position", () => {
    expect(matchChoice(choices, "2")?.id).toBe("no");
  });

  test("matches a label regardless of case", () => {
    expect(matchChoice(choices, "  accept ")?.id).toBe("yes");
  });

  test("refuses a number outside the range", () => {
    expect(matchChoice(choices, "3")).toBeUndefined();
    expect(matchChoice(choices, "0")).toBeUndefined();
  });

  test("refuses an unrelated message so it falls through to the agent", () => {
    expect(matchChoice(choices, "what's the weather")).toBeUndefined();
    expect(matchChoice(choices, "")).toBeUndefined();
  });

  test("refuses a number with trailing prose, which is a sentence not a pick", () => {
    expect(matchChoice(choices, "2 sounds wrong to me")).toBeUndefined();
  });
});

describe("renderChoicesAsText", () => {
  test("numbers from one so the reply matches the prompt", () => {
    expect(
      renderChoicesAsText([
        { id: "a", label: "Accept" },
        { id: "b", label: "Reject" },
      ]),
    ).toBe("1. Accept\n2. Reject");
  });
});

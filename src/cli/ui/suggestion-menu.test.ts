import { describe, expect, test } from "bun:test";
import { mergeSuggestions } from "./suggestion-menu";

const command = { name: "model", description: "Change model" };
const mention = { name: "src/foo.ts", description: "" };

describe("mergeSuggestions", () => {
  test("shows slash commands when there are any", () => {
    expect(mergeSuggestions([command], [])).toEqual({ items: [command], prefix: "/" });
  });

  test("shows mentions when there are no commands", () => {
    expect(mergeSuggestions([], [mention])).toEqual({ items: [mention], prefix: "@" });
  });

  test("prefers commands over mentions when both are non-empty", () => {
    // The rule both composers used to encode separately — and differently.
    expect(mergeSuggestions([command], [mention])).toEqual({ items: [command], prefix: "/" });
  });

  test("hides the menu when there is nothing to show", () => {
    expect(mergeSuggestions([], [])).toBeUndefined();
  });
});

import { describe, expect, it } from "bun:test";
import { CHAT_COMMANDS } from "./constants";
import { mayBeGoalRequest } from "./goal";

describe("mayBeGoalRequest", () => {
  it("selects explicit broad objectives for goal planning", () => {
    expect(mayBeGoalRequest("Improve detach")).toBe(true);
    expect(mayBeGoalRequest("I want to improve Jazz's evaluation pipeline")).toBe(true);
    expect(mayBeGoalRequest("Improve app performance to 20%")).toBe(true);
    expect(mayBeGoalRequest("can you make the importer faster")).toBe(true);
    expect(mayBeGoalRequest("Make the test suite less flaky")).toBe(true);
  });

  it("leaves questions and hypothetical discussion in the ordinary chat path", () => {
    expect(mayBeGoalRequest("How do we improve detach?")).toBe(false);
    expect(mayBeGoalRequest("Could we improve the eval suite someday?")).toBe(false);
    expect(mayBeGoalRequest("I think we should improve Jazz")).toBe(false);
    expect(mayBeGoalRequest("What does improve detach mean?")).toBe(false);
  });

  it("does not activate from a short or oversized turn", () => {
    expect(mayBeGoalRequest("improve")).toBe(false);
    expect(mayBeGoalRequest(`Improve ${"x".repeat(4000)}`)).toBe(false);
  });

  it("advertises goal controls in slash-command help and autocomplete", () => {
    expect(CHAT_COMMANDS.find((command) => command.name === "goal")).toMatchObject({
      usage: "<objective>|list|pause <id>|resume <id> [note]|cancel <id>",
    });
  });
});

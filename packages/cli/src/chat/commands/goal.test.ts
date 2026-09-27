import { describe, expect, it } from "bun:test";
import { CHAT_COMMANDS } from "./constants";

describe("/goal command", () => {
  it("advertises goal controls in slash-command help and autocomplete", () => {
    const goal = CHAT_COMMANDS.find((command) => command.name === "goal");
    expect(goal?.usage).toBe("[objective|pause|resume|clear|list|accept|decline]");
    expect(goal?.forms?.map((entry) => entry.form)).toContain("/goal clear");
  });
});

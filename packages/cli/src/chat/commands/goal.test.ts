import { describe, expect, it } from "bun:test";
import { CHAT_COMMANDS } from "./constants";

describe("/goal command", () => {
  it("advertises goal controls in slash-command help and autocomplete", () => {
    expect(CHAT_COMMANDS.find((command) => command.name === "goal")).toMatchObject({
      usage:
        "<objective>|list|accept <id> [tier]|decline <id>|pause <id>|resume <id> [note]|cancel <id>",
    });
  });
});

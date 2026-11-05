import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "@/core/types/message";
import { collectUnlockedToolNames } from "./unlocked-tools";

const toolMessage = (unlockedToolNames?: readonly string[]): ChatMessage => ({
  role: "tool",
  name: "search_tools",
  content: "{}",
  ...(unlockedToolNames ? { unlockedToolNames } : {}),
});

describe("collectUnlockedToolNames", () => {
  it("returns unlocks in first-unlock order without duplicates", () => {
    const history = [toolMessage(["b", "a"]), toolMessage(), toolMessage(["a", "c"])];
    expect(collectUnlockedToolNames(history, ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("drops tools this run no longer offers", () => {
    expect(collectUnlockedToolNames([toolMessage(["a", "gone"])], ["a"])).toEqual(["a"]);
  });

  it("returns nothing for a history with no unlocks", () => {
    expect(collectUnlockedToolNames([toolMessage()], ["a"])).toEqual([]);
  });
});

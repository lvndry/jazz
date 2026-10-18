import { describe, expect, it } from "bun:test";
import { createBlackboard, MAX_BLACKBOARD_ENTRIES } from "./blackboard";

const post = (topic: string, content: string) => ({ author: "doc 1", topic, content });

describe("Blackboard", () => {
  it("returns posts oldest first, and only newer ones after a cursor", () => {
    const board = createBlackboard();
    board.post(post("auth", "token refresh lives in src/auth/refresh.ts"));
    const second = board.post(post("auth", "refresh is retried 3 times"));
    board.post(post("pricing", "plans are in config/plans.json"));

    expect(board.read({}).entries.map((entry) => entry.content)).toEqual([
      "token refresh lives in src/auth/refresh.ts",
      "refresh is retried 3 times",
      "plans are in config/plans.json",
    ]);
    expect(board.read({ afterId: second.id }).entries.map((entry) => entry.topic)).toEqual([
      "pricing",
    ]);
  });

  it("filters by topic, ignoring case", () => {
    const board = createBlackboard();
    board.post(post("Auth", "one"));
    board.post(post("pricing", "two"));
    expect(board.read({ topic: "auth" }).entries.map((entry) => entry.content)).toEqual(["one"]);
  });

  it("drops the oldest posts past its cap and tells a reader how many it missed", () => {
    const board = createBlackboard();
    for (let index = 0; index < MAX_BLACKBOARD_ENTRIES + 3; index++) {
      board.post(post("bulk", String(index)));
    }
    const read = board.read({});
    expect(read.entries).toHaveLength(MAX_BLACKBOARD_ENTRIES);
    expect(read.entries[0]?.content).toBe("3");
    expect(read.dropped).toBe(3);
    expect(board.read({ afterId: read.entries.at(-1)!.id }).dropped).toBe(0);
  });
});

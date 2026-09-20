import { describe, test, expect } from "bun:test";
import { activeTopics, matchTopics } from "./topics";

function active(requestText: string, topics: readonly string[]): readonly string[] {
  return activeTopics(matchTopics(requestText, topics));
}

describe("matchTopics", () => {
  test("fires on a topic the request names", () => {
    expect(active("make me a moodboard for the pitch", ["moodboard", "invoicing"])).toEqual([
      "moodboard",
    ]);
  });

  test("tolerates a different spelling of the stored topic", () => {
    expect(active("build a moodboard", ["mood-board"])).toEqual(["mood-board"]);
  });

  test("does not fire on a fragment of a longer word", () => {
    for (const request of ["start the server", "the second part", "a smart idea"]) {
      expect(active(request, ["art"])).toEqual([]);
    }
  });

  test("refuses to match a topic too short to be meant", () => {
    const [match] = matchTopics("start the server", ["art"]);
    expect(match).toEqual({ topic: "art", matched: false, reason: "too-short" });
  });

  test("depends on the request, not on where the run happens", () => {
    expect(active("", ["moodboard"])).toEqual([]);
  });

  test("reports why each topic did or did not fire", () => {
    const matches = matchTopics("redo the moodboard", ["moodboard", "mood-board", "invoicing"]);
    expect(matches).toEqual([
      { topic: "invoicing", matched: false, reason: "not-mentioned" },
      { topic: "mood-board", matched: true, reason: "spelled-differently" },
      { topic: "moodboard", matched: true, reason: "named" },
    ]);
  });

  test("matches every topic the request is about, not just the first", () => {
    expect(active("invoice the moodboard work", ["moodboard", "invoicing"])).toEqual(["moodboard"]);
    expect(active("moodboard and invoicing", ["moodboard", "invoicing"])).toEqual([
      "invoicing",
      "moodboard",
    ]);
  });

  test("is case-insensitive", () => {
    expect(active("Build a MOODBOARD", ["moodboard"])).toEqual(["moodboard"]);
  });
});

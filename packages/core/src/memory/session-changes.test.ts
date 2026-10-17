import { describe, expect, it } from "bun:test";
import {
  describeSessionMemoryChanges,
  diffMemoryStates,
  hasSessionMemoryChanges,
  type MemoryState,
} from "./session-changes";

function state(entries: Record<string, [summary: string, contentHash: string]>): MemoryState {
  return new Map(
    Object.entries(entries).map(([path, [summary, contentHash]]) => [
      path,
      { summary, contentHash },
    ]),
  );
}

describe("diffMemoryStates", () => {
  it("sorts entries into added, changed and removed by path and content hash", () => {
    const before = state({
      "personal/kept.md": ["Kept", "hash-kept"],
      "personal/edited.md": ["Old wording", "hash-old"],
      "personal/gone.md": ["Gone", "hash-gone"],
    });
    const after = state({
      "personal/kept.md": ["Kept", "hash-kept"],
      "personal/edited.md": ["New wording", "hash-new"],
      "personal/when/food/fruit.md": ["Likes mangoes", "hash-fruit"],
    });

    expect(diffMemoryStates(before, after)).toEqual({
      added: [{ path: "personal/when/food/fruit.md", summary: "Likes mangoes" }],
      changed: [{ path: "personal/edited.md", summary: "New wording" }],
      removed: [{ path: "personal/gone.md", summary: "Gone" }],
    });
  });

  it("reports nothing when the store is unchanged", () => {
    const unchanged = state({ "personal/kept.md": ["Kept", "hash-kept"] });
    const changes = diffMemoryStates(unchanged, unchanged);

    expect(hasSessionMemoryChanges(changes)).toBe(false);
    expect(describeSessionMemoryChanges(changes)).toBe(
      "No memory entries were added, changed or removed during this session.",
    );
  });
});

describe("describeSessionMemoryChanges", () => {
  it("lists only the groups that have entries", () => {
    const text = describeSessionMemoryChanges({
      added: [{ path: "personal/a.md", summary: "A" }],
      changed: [],
      removed: [{ path: "personal/b.md", summary: "B" }],
    });

    expect(text).toBe("Added:\n- personal/a.md: A\n\nRemoved:\n- personal/b.md: B");
  });
});

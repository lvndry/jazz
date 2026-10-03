import { describe, expect, test } from "bun:test";
import type { BackgroundItem } from "@/cli/ui/models/background-work";
import { formatBackgroundItem, resolveBackgroundItem } from "./waits";

function item(batchId: string): BackgroundItem {
  return {
    batchId,
    kind: "watch",
    description: "CI run",
    command: "gh run view 1",
    startedAt: 0,
    intervalMs: 30_000,
    expiresAt: 300_000,
    progress: "",
  };
}

describe("resolveBackgroundItem", () => {
  const items = [item("batch-aaa"), item("batch-abb"), item("zzz")];

  test("takes a 1-based list number", () => {
    expect(resolveBackgroundItem(items, "3")?.batchId).toBe("zzz");
    expect(resolveBackgroundItem(items, "4")).toBeUndefined();
  });

  test("takes an unambiguous batch id prefix", () => {
    expect(resolveBackgroundItem(items, "zz")?.batchId).toBe("zzz");
    expect(resolveBackgroundItem(items, "batch-a")).toBeUndefined();
  });
});

describe("formatBackgroundItem", () => {
  test("adds the newest check once one has run", () => {
    const checked = { ...item("x"), progress: "check 4 · exit 1 · in_progress" };
    expect(formatBackgroundItem(checked, 1, 60_000)).toBe(
      "1. CI run\n   every 30s: gh run view 1 · gives up in 4m 00s\n   check 4 · exit 1 · in_progress",
    );
  });

  test("numbers the item and shows its check and deadline", () => {
    expect(formatBackgroundItem(item("x"), 2, 60_000)).toBe(
      "2. CI run\n   every 30s: gh run view 1 · gives up in 4m 00s",
    );
  });
});

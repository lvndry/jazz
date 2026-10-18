/** Proves a snapshot's identity changes exactly when the set's membership does. */
import { describe, expect, test } from "bun:test";
import { SnapshotSet } from "./snapshot-set";

describe("snapshot set", () => {
  test("hands out one snapshot until the membership changes", () => {
    const ids = new SnapshotSet<string>();
    const empty = ids.snapshot();
    expect(ids.snapshot()).toBe(empty);
    ids.add("first");
    const withFirst = ids.snapshot();
    expect(withFirst).not.toBe(empty);
    expect([...withFirst]).toEqual(["first"]);
    ids.add("first");
    ids.delete("missing");
    expect(ids.snapshot()).toBe(withFirst);
    ids.delete("first");
    expect([...ids.snapshot()]).toEqual([]);
    expect([...withFirst]).toEqual(["first"]);
    const cleared = ids.snapshot();
    ids.clear();
    expect(ids.snapshot()).toBe(cleared);
  });
});

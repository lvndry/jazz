import { describe, expect, it } from "bun:test";
import { BoundedLruCache } from "./bounded-lru-cache";

describe("BoundedLruCache", () => {
  it("evicts the least recently used entry once over capacity", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("first", 1);
    cache.set("second", 2);
    cache.get("first");
    cache.set("third", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(1);
    expect(cache.get("third")).toBe(3);
  });

  it("replaces an existing key without growing", () => {
    const cache = new BoundedLruCache<string, number>(2);
    cache.set("key", 1);
    cache.set("key", 2);

    expect(cache.size).toBe(1);
    expect(cache.get("key")).toBe(2);
  });
});

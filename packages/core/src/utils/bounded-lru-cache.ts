/**
 * An insertion-ordered least-recently-used cache holding at most `capacity` entries.
 *
 * `Map` preserves insertion order. Moving a hit to the end makes the first key the least
 * recently used entry, so eviction needs no timers or background work.
 */
export class BoundedLruCache<Key, Value> {
  private readonly entries = new Map<Key, Value>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: Key): Value | undefined {
    if (!this.entries.has(key)) {
      return undefined;
    }
    const value = this.entries.get(key) as Value;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: Key, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const leastRecentlyUsed = this.entries.keys().next();
      if (leastRecentlyUsed.done === true) {
        return;
      }
      this.entries.delete(leastRecentlyUsed.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

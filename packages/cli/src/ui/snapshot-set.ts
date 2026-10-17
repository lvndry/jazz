/**
 * A mutable set whose read-only snapshot is copied only after a change, so a
 * snapshot's identity tells a renderer whether the set changed since its last
 * projection, and an unchanged set costs nothing to publish.
 */
export class SnapshotSet<Value> {
  private readonly values = new Set<Value>();
  private copy: ReadonlySet<Value> | undefined;

  get size(): number {
    return this.values.size;
  }

  has(value: Value): boolean {
    return this.values.has(value);
  }

  add(value: Value): this {
    if (!this.values.has(value)) {
      this.values.add(value);
      this.copy = undefined;
    }
    return this;
  }

  delete(value: Value): boolean {
    const deleted = this.values.delete(value);
    if (deleted) {
      this.copy = undefined;
    }
    return deleted;
  }

  clear(): void {
    if (this.values.size > 0) {
      this.values.clear();
      this.copy = undefined;
    }
  }

  snapshot(): ReadonlySet<Value> {
    this.copy ??= new Set(this.values);
    return this.copy;
  }
}

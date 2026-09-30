/**
 * The holder a run keeps for one external resource its tools share, such as a browser or a
 * desktop driver.
 *
 * The runner opens one holder for a top-level run, hands the same object to its sub-agents, and
 * closes it when the run finishes, errors or is interrupted. The resource itself is created
 * lazily by the first tool call, so a run that never uses it never starts it.
 */

/** Anything the holder can shut down. */
export interface ClosableResource {
  close(): Promise<void>;
}

export class RunScopedResource<Resource extends ClosableResource> {
  private current: Promise<Resource> | undefined;
  private closed = false;

  /** `closedMessage` is the error a call gets once the run has ended. */
  constructor(private readonly closedMessage: string) {}

  /** The run's resource, creating it with `create` the first time. */
  obtain(create: () => Promise<Resource>): Promise<Resource> {
    if (this.closed) {
      return Promise.reject(new Error(this.closedMessage));
    }
    if (this.current === undefined) {
      const pending = create();
      this.current = pending;
      pending.catch(() => {
        if (this.current === pending) {
          this.current = undefined;
        }
      });
    }
    return this.current;
  }

  /** The run's resource when one was created, without creating it. */
  peek(): Promise<Resource> | undefined {
    return this.current;
  }

  /** Close the resource if one was created; the next `obtain` creates a fresh one. */
  async release(): Promise<void> {
    const pending = this.current;
    this.current = undefined;
    if (pending === undefined) {
      return;
    }
    const resource = await pending.catch(() => undefined);
    await resource?.close();
  }

  /**
   * End the run's use of the resource: close it and refuse to create another. Safe to call twice
   * and while a creation is pending.
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.release();
  }
}

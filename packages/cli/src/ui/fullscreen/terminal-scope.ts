/**
 * Own cleanup for a terminal runtime acquisition, including partial startup.
 *
 * Add each cleanup immediately after acquiring its resource. release runs all
 * cleanups once in reverse order, even if a cleanup fails, and then reports the
 * first failure. A resource acquired after release is disposed immediately.
 */

export class TerminalScope {
  private readonly cleanups: (() => void)[] = [];
  private released = false;

  add(cleanup: () => void): void {
    if (this.released) cleanup();
    else this.cleanups.push(cleanup);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    let firstFailure: unknown;
    let failed = false;
    while (this.cleanups.length > 0) {
      try {
        this.cleanups.pop()?.();
      } catch (error) {
        if (!failed) firstFailure = error;
        failed = true;
      }
    }
    if (failed) throw firstFailure;
  }
}

import { describe, expect, test } from "bun:test";
import { mountFullscreenApp, type FullscreenHandle } from "./attach";
import { decideFullscreen, installTerminalLifecycle, type LifecycleRenderer } from "./mount";

const ENVIRONMENT = { TERM: "xterm-256color" };
const OUTPUT = { isTTY: true, columns: 100, rows: 24 };
const INPUT = { isTTY: true };

describe("decideFullscreen", () => {
  test("accepts a capable interactive terminal", () => {
    expect(decideFullscreen({}, ENVIRONMENT, OUTPUT, INPUT)).toEqual({
      fullscreen: true,
      width: 100,
      height: 24,
    });
  });

  test("rejects every environment that requires append-only output", () => {
    expect(decideFullscreen({}, { ...ENVIRONMENT, CI: "1" }, OUTPUT, INPUT).reason).toBe("ci");
    expect(decideFullscreen({}, { TERM: "dumb" }, OUTPUT, INPUT).reason).toBe("dumb-terminal");
    expect(decideFullscreen({}, { ...ENVIRONMENT, JAZZ_A11Y: "1" }, OUTPUT, INPUT).reason).toBe(
      "screen-reader",
    );
    expect(decideFullscreen({}, ENVIRONMENT, { ...OUTPUT, columns: 59 }, INPUT).reason).toBe(
      "too-small",
    );
    expect(decideFullscreen({}, ENVIRONMENT, OUTPUT, { isTTY: false }).reason).toBe("not-a-tty");
  });
});

describe("mountFullscreenApp", () => {
  test("reports OpenTUI startup failure so the caller can mount its fallback", async () => {
    const originalWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let handle: FullscreenHandle | undefined;
    let failure: unknown;

    try {
      await new Promise<void>((resolve) => {
        handle = mountFullscreenApp({
          mount: () => Promise.reject(new Error("terminal setup failed")),
          onFailure: (error) => {
            failure = error;
            resolve();
          },
        });
      });
    } finally {
      handle?.release();
      process.stderr.write = originalWrite;
    }

    expect(failure).toEqual(new Error("terminal setup failed"));
  });

  test("does not mount a fallback after release", async () => {
    let fallbackCalled = false;
    let rejectMount: ((error: Error) => void) | undefined;
    const handle = mountFullscreenApp({
      mount: () =>
        new Promise((_, reject) => {
          rejectMount = reject;
        }),
      onFailure: () => {
        fallbackCalled = true;
      },
    });
    handle.release();
    rejectMount?.(new Error("late failure"));
    await Promise.resolve();
    expect(fallbackCalled).toBe(false);
  });
});

describe("installTerminalLifecycle", () => {
  function stubRuntime() {
    const listeners = new Map<string, () => void>();
    return {
      listeners,
      runtime: {
        pid: 1,
        on: (event: string, listener: () => void) => listeners.set(event, listener),
        off: (event: string, listener: () => void) => {
          if (listeners.get(event) === listener) listeners.delete(event);
        },
        kill: () => true,
      },
    };
  }

  function stubRenderer() {
    const calls = { destroy: 0, suspend: 0, resume: 0 };
    return {
      calls,
      renderer: {
        get isDestroyed() {
          return calls.destroy > 0;
        },
        destroy: () => {
          calls.destroy += 1;
        },
        suspend: () => {
          calls.suspend += 1;
        },
        resume: () => {
          calls.resume += 1;
        },
        requestRender: () => {},
        resetTerminalBgColor: () => {},
      } as unknown as LifecycleRenderer,
    };
  }

  test("restores the terminal when the process exits without a signal", () => {
    const { listeners, runtime } = stubRuntime();
    const { calls, renderer } = stubRenderer();

    installTerminalLifecycle(renderer, runtime);
    listeners.get("exit")?.();

    // Without this the wizard's `process.exit(0)` would leave mouse reporting
    // on, and the shell would print every mouse move as `35;97;18M`.
    expect(calls.destroy).toBe(1);
  });

  test("releases once, and stops listening afterwards", () => {
    const { listeners, runtime } = stubRuntime();
    const { calls, renderer } = stubRenderer();

    const release = installTerminalLifecycle(renderer, runtime);
    const onExit = listeners.get("exit");
    release();
    release();
    onExit?.();

    expect(calls.destroy).toBe(1);
    expect(listeners.size).toBe(0);
  });

  test("ignores job-control signals once released", () => {
    const { listeners, runtime } = stubRuntime();
    const { calls, renderer } = stubRenderer();

    const release = installTerminalLifecycle(renderer, runtime);
    const onSuspend = listeners.get("SIGTSTP");
    const onContinue = listeners.get("SIGCONT");
    release();
    onSuspend?.();
    onContinue?.();

    expect(calls.suspend).toBe(0);
    expect(calls.resume).toBe(0);
  });
});

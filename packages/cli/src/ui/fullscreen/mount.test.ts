import { describe, expect, test } from "bun:test";
import { mountFullscreenApp, type FullscreenHandle } from "./attach";
import {
  decideFullscreen,
  guardOutput,
  installTerminalLifecycle,
  repaintAfterResize,
  transcriptTextForForeignWrite,
  type GuardedStream,
  type LifecycleRenderer,
} from "./mount";
import type { OutputEntry } from "../types";

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
    const kills: string[] = [];
    return {
      listeners,
      kills,
      runtime: {
        pid: 1,
        on: (event: string, listener: () => void) => listeners.set(event, listener),
        off: (event: string, listener: () => void) => {
          if (listeners.get(event) === listener) listeners.delete(event);
        },
        kill: (_pid: number, signal: string) => kills.push(signal),
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

  test("hands the terminal back on suspend and re-enters on continue", () => {
    const { listeners, kills, runtime } = stubRuntime();
    const { calls, renderer } = stubRenderer();

    installTerminalLifecycle(renderer, runtime);

    // Asserted before the handlers run: reading them with `get(...)?.()` and
    // checking for zero calls would pass just as well if the registrations were
    // dropped altogether, which is how job control could regress unnoticed.
    expect(listeners.has("SIGTSTP")).toBe(true);
    expect(listeners.has("SIGCONT")).toBe(true);

    listeners.get("SIGTSTP")?.();
    expect(calls.suspend).toBe(1);
    // The stop has to come after the terminal is handed back, or the shell
    // resumes into a screen the renderer still owns.
    expect(kills).toEqual(["SIGSTOP"]);

    listeners.get("SIGCONT")?.();
    expect(calls.resume).toBe(1);
  });

  test("ignores job-control signals once released", () => {
    const { listeners, runtime } = stubRuntime();
    const { calls, renderer } = stubRenderer();

    const release = installTerminalLifecycle(renderer, runtime);
    const onSuspend = listeners.get("SIGTSTP");
    const onContinue = listeners.get("SIGCONT");
    expect(onSuspend).toBeDefined();
    expect(onContinue).toBeDefined();
    release();
    onSuspend?.();
    onContinue?.();

    expect(calls.suspend).toBe(0);
    expect(calls.resume).toBe(0);
  });

  test("ignores job-control signals when the renderer was destroyed elsewhere", () => {
    const { listeners, kills, runtime } = stubRuntime();
    const { calls, renderer } = stubRenderer();

    installTerminalLifecycle(renderer, runtime);

    // OpenTUI's own exit handler is just `destroy()`, and it does not exit the
    // process — so a first Ctrl+C leaves a destroyed renderer while jazz runs
    // its graceful shutdown, with `release` never called. `suspend()` and
    // `resume()` do not check `isDestroyed`, and `destroy()` leaves
    // `rendererPtr` dangling, so acting here would call into a freed renderer.
    renderer.destroy();

    listeners.get("SIGTSTP")?.();
    listeners.get("SIGCONT")?.();

    expect(calls.suspend).toBe(0);
    expect(calls.resume).toBe(0);
    expect(kills).toEqual([]);
  });
});

describe("transcriptTextForForeignWrite", () => {
  test("routes anything that would paint cells into the transcript", () => {
    expect(transcriptTextForForeignWrite("visit https://example.com\n")).toBe(
      "visit https://example.com",
    );
    // Styled text still paints — the desync does not care that it is pretty.
    expect(transcriptTextForForeignWrite("\u001b[32mdone\u001b[39m\n")).toBe(
      "\u001b[32mdone\u001b[39m",
    );
  });

  test("lets pure control sequences through untouched", () => {
    // Setting the window title paints no cells, so intercepting it would only
    // put `0;jazz` in the transcript and lose the title.
    expect(transcriptTextForForeignWrite("\u001b]0;jazz\u0007")).toBeNull();
    expect(transcriptTextForForeignWrite("\u001b[?2004h")).toBeNull();
    expect(transcriptTextForForeignWrite("\n")).toBeNull();
  });
});

function stubStream(): GuardedStream & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    write(chunk: unknown) {
      written.push(String(chunk));
      return true;
    },
  };
}

describe("guardOutput", () => {
  function setup(isDestroyed = false) {
    const out = stubStream();
    const err = stubStream();
    const entries: OutputEntry[] = [];
    const restore = guardOutput({ isDestroyed }, (entry) => entries.push(entry), { out, err });
    return { out, err, entries, restore };
  }

  test("takes text off the screen and puts it in the transcript", () => {
    const { out, err, entries, restore } = setup();

    out.write("this would desync the frame\n");
    err.write("AI SDK warning: something\n");
    restore();

    expect(out.written).toEqual([]);
    expect(err.written).toEqual([]);
    expect(entries.map((entry) => [entry.type, entry.message])).toEqual([
      ["log", "this would desync the frame"],
      ["warn", "AI SDK warning: something"],
    ]);
  });

  test("lets control sequences reach the terminal", () => {
    const { out, entries, restore } = setup();

    // The window title, and OpenTUI's own palette queries, paint no cells.
    out.write("\u001b]0;jazz\u0007");
    restore();

    expect(out.written).toEqual(["\u001b]0;jazz\u0007"]);
    expect(entries).toEqual([]);
  });

  test("stands aside once the renderer is destroyed", () => {
    // OpenTUI's uncaughtException handler destroys the renderer before anything
    // prints, so the crash has to reach a terminal that can still show it.
    const { err, entries, restore } = setup(true);

    err.write("Error: it all fell over\n");
    restore();

    expect(err.written).toEqual(["Error: it all fell over\n"]);
    expect(entries).toEqual([]);
  });

  test("restores the original write", () => {
    const { out, entries, restore } = setup();
    restore();

    out.write("after\n");

    expect(out.written).toEqual(["after\n"]);
    expect(entries).toEqual([]);
  });
});

describe("repaintAfterResize", () => {
  function stubRepaintRenderer(forceFullRepaintRequested: unknown) {
    const listeners = new Set<() => void>();
    let renders = 0;
    return {
      forceFullRepaintRequested,
      get renders() {
        return renders;
      },
      resize: () => {
        for (const listener of [...listeners]) listener();
      },
      on: (_event: "resize", listener: () => void) => listeners.add(listener),
      off: (_event: "resize", listener: () => void) => listeners.delete(listener),
      requestRender: () => {
        renders += 1;
      },
    };
  }

  test("asks for a full repaint when the terminal changes size", () => {
    const renderer = stubRepaintRenderer(false);

    const stop = repaintAfterResize(renderer);
    renderer.resize();

    expect(renderer.forceFullRepaintRequested).toBe(true);
    expect(renderer.renders).toBe(1);

    stop();
    renderer.forceFullRepaintRequested = false;
    renderer.resize();
    expect(renderer.forceFullRepaintRequested).toBe(false);
    expect(renderer.renders).toBe(1);
  });

  test("does nothing if OpenTUI ever renames the flag", () => {
    const renderer = stubRepaintRenderer("not a flag any more");

    repaintAfterResize(renderer);
    renderer.resize();

    expect(renderer.forceFullRepaintRequested).toBe("not a flag any more");
    expect(renderer.renders).toBe(0);
  });
});

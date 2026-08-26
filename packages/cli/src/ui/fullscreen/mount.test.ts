import { describe, expect, test } from "bun:test";
import { mountFullscreenApp, type FullscreenHandle } from "./attach";
import { decideFullscreen } from "./mount";

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

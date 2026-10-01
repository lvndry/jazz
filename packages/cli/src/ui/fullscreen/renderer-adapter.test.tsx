/** @jsxImportSource @opentui/react */

/**
 * Qualify the pinned backend's writer boundary with actual native frames and an
 * independent VT grid. Tests cover erased blank cells, demand-driven idle frames,
 * stream control rejection, native failure observation and scoped restoration.
 */

import type { CliRenderer } from "@opentui/core";
import { expect, test } from "bun:test";
import { guardOutput, type GuardedStream } from "./mount";
import { observeNativeFailure, rendererInvalidation } from "./renderer-adapter";
import { createTerminalOracle } from "./testing/terminal-oracle";

test("foreign erasure and control chunks cannot desynchronize the physical grid", async () => {
  const oracle = await createTerminalOracle({ width: 32, height: 10 });
  const foreign: string[] = [];
  const passedThrough: Promise<void>[] = [];
  const stream: GuardedStream = {
    write: (chunk) => {
      passedThrough.push(oracle.writeTerminal(String(chunk)));
      return true;
    },
  };
  const original = stream.write;
  const restore = guardOutput(oracle.renderer, (entry) => foreign.push(String(entry.message)), {
    out: stream,
    err: stream,
  });
  try {
    oracle.render(<text>Expected answer</text>);
    await oracle.flush();
    const before = oracle.captureGrid();
    for (const chunk of ["\x1b[2J\x1b[H", "\r\n", "\x1b]0;foreign\x07", "\x1b[?1049l"]) {
      stream.write(chunk);
    }
    await Promise.all(passedThrough);
    await oracle.flush();
    expect(oracle.captureGrid()).toEqual(before);
    expect(oracle.compareGrid()).toEqual([]);
    expect(foreign).toEqual([]);
    expect(passedThrough).toEqual([]);
  } finally {
    restore();
    restore();
    expect(stream.write).toBe(original);
    oracle.dispose();
  }
});

test("physical invalidation repairs blanks and glyphs without an external clear", async () => {
  const oracle = await createTerminalOracle({ width: 32, height: 10 });
  try {
    oracle.render(<text>Expected answer</text>);
    await oracle.flush();
    await oracle.writeTerminal("\x1b[2J\x1b[1;1HX\x1b[10;32HY");
    expect(oracle.compareGrid().length).toBeGreaterThan(0);
    rendererInvalidation(oracle.renderer).invalidate();
    await oracle.flush();
    expect(oracle.compareGrid()).toEqual([]);
  } finally {
    oracle.dispose();
  }
});

test("demand frames settle, stay idle, then paint the next mutation", async () => {
  const oracle = await createTerminalOracle({ width: 32, height: 10 });
  let frames = 0;
  const onFrame = (): void => {
    frames++;
  };
  oracle.renderer.on("frame", onFrame);
  try {
    oracle.render(<text>First</text>);
    await oracle.flush();
    const settled = frames;
    expect(settled).toBeGreaterThan(0);
    expect(oracle.renderer.getSchedulerState()).toEqual({
      isRunning: false,
      isRendering: false,
      hasScheduledRender: false,
    });
    await Bun.sleep(120);
    expect(frames).toBe(settled);
    oracle.render(<text>Next</text>);
    await oracle.flush();
    expect(frames).toBeGreaterThan(settled);
    expect(oracle.compareGrid()).toEqual([]);
  } finally {
    oracle.renderer.off("frame", onFrame);
    oracle.dispose();
  }
});

test("native failure observation restores the exact backend method", () => {
  const original = (): string => "failed";
  const backend = { renderNative: original };
  const failures: Error[] = [];
  const stop = observeNativeFailure(backend as unknown as CliRenderer, (error) =>
    failures.push(error),
  );
  expect(backend.renderNative()).toBe("failed");
  expect(failures).toEqual([new Error("OpenTUI native output failed")]);
  stop();
  stop();
  expect(backend.renderNative).toBe(original);
});

test("native feed backpressure remains retryable rather than triggering fallback", () => {
  let result = "retryable-skip";
  const backend = { renderNative: () => result };
  const failures: Error[] = [];
  const stop = observeNativeFailure(backend as unknown as CliRenderer, (error) =>
    failures.push(error),
  );
  try {
    for (const status of ["retryable-skip", "backpressured", "blocked", "rendered"]) {
      result = status;
      expect(backend.renderNative()).toBe(status);
    }
    expect(failures).toEqual([]);
  } finally {
    stop();
  }
});

test("recursive sink writes remain captured and callbacks settle", async () => {
  const written: string[] = [];
  const stream: GuardedStream = {
    write: (chunk) => {
      written.push(String(chunk));
      return true;
    },
  };
  const restore = guardOutput({ isDestroyed: false }, () => stream.write("\x1b[2J"), {
    out: stream,
    err: stream,
  });
  try {
    await new Promise<void>((resolve) => stream.write("A notice", resolve));
    expect(written).toEqual([]);
  } finally {
    restore();
  }
});

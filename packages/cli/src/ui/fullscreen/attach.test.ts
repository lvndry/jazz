/**
 * Qualify asynchronous fullscreen acquisition and runtime failure handoff.
 *
 * These tests exercise a native renderer on custom streams, never the user's
 * terminal. Fallback must happen once after resource release, retain the caller's
 * error privately, and issue only a generic diagnostic. Title and invalidation
 * are deliberate capabilities that stay inert once their owner is released.
 */

import type { CliRenderer } from "@opentui/core";
import { expect, test } from "bun:test";
import { mountFullscreenApp } from "./attach";
import type { MountedRenderer } from "./mount";
import { createTerminalOracle } from "./testing/terminal-oracle";

test("runtime errors hand off once after releasing the native renderer", async () => {
  const oracle = await createTerminalOracle({ width: 60, height: 20 });
  const originalWriter: unknown = Reflect.get(oracle.renderer, "renderNative");
  const diagnostics: string[] = [];
  const originalStderr = process.stderr.write;
  process.stderr.write = (chunk: unknown): boolean => {
    diagnostics.push(String(chunk));
    return true;
  };
  let releases = 0;
  let failures = 0;
  let reported: unknown;
  let resolveFailure: (() => void) | undefined;
  const failed = new Promise<void>((resolve) => {
    resolveFailure = resolve;
  });
  const error = new Error("private detail must not appear in diagnostic");
  const handle = mountFullscreenApp({
    mount: async () => ({
      renderer: oracle.renderer,
      release: () => {
        releases++;
        oracle.dispose();
      },
    }),
    onFailure: (failure) => {
      failures++;
      reported = failure;
      expect(oracle.renderer.isDestroyed).toBe(true);
      resolveFailure?.();
    },
  });
  try {
    await Bun.sleep(0);
    await oracle.renderer.idle();
    expect(oracle.renderer.listenerCount("render:error")).toBeGreaterThan(0);
    oracle.renderer.emit("render:error", { error });
    oracle.renderer.emit("handler:error", { error });
    await failed;
    handle.release();
    handle.invalidate();
    handle.setTitle("late title");
    expect(releases).toBe(1);
    expect(failures).toBe(1);
    expect(reported).toBe(error);
    expect(diagnostics).toEqual([
      "jazz: fullscreen interface failed; using the standard interface\n",
    ]);
    expect(oracle.renderer.listenerCount("render:error")).toBe(0);
    expect(oracle.renderer.listenerCount("handler:error")).toBe(0);
    expect(Reflect.get(oracle.renderer, "renderNative")).toBe(originalWriter);
  } finally {
    handle.release();
    oracle.dispose();
    process.stderr.write = originalStderr;
  }
});

test("partial setup releases acquisitions even when a listener cleanup throws", async () => {
  const listeners = new Map<string, () => void>();
  let releases = 0;
  let restored = false;
  const nativeWriter = (): string => "rendered";
  const setupFailure = new Error("event acquisition failed");
  const backend = {
    forceFullRepaintRequested: false,
    requestRender: () => undefined,
    renderNative: nativeWriter,
    on: (event: string, listener: () => void) => {
      if (event === "handler:error") throw setupFailure;
      listeners.set(event, listener);
    },
    off: (event: string) => {
      listeners.delete(event);
      throw new Error("cleanup failed");
    },
  };
  const originalStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let handle: ReturnType<typeof mountFullscreenApp> | undefined;
  try {
    const reported = await new Promise<unknown>((resolve) => {
      handle = mountFullscreenApp({
        mount: async (): Promise<MountedRenderer> => ({
          renderer: backend as unknown as CliRenderer,
          release: () => {
            releases++;
            restored = backend.renderNative === nativeWriter;
          },
        }),
        onFailure: resolve,
      });
    });
    expect(reported).toBe(setupFailure);
    expect(releases).toBe(1);
    expect(restored).toBe(true);
    expect(listeners.size).toBe(0);
  } finally {
    handle?.release();
    process.stderr.write = originalStderr;
  }
});

test("a rejected native frame triggers handoff without a public render error event", async () => {
  const oracle = await createTerminalOracle({ width: 60, height: 20 });
  await oracle.flush();
  const originalWriter: unknown = Reflect.get(oracle.renderer, "renderNative");
  Reflect.set(oracle.renderer, "renderNative", () => "failed");
  const originalStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let releases = 0;
  let failures = 0;
  let handle: ReturnType<typeof mountFullscreenApp> | undefined;
  try {
    const reported = await new Promise<unknown>((resolve) => {
      handle = mountFullscreenApp({
        mount: async () => ({
          renderer: oracle.renderer,
          release: () => {
            releases++;
            oracle.dispose();
          },
        }),
        onFailure: (error) => {
          failures++;
          resolve(error);
        },
      });
    });
    expect(reported).toEqual(new Error("OpenTUI native output failed"));
    expect(releases).toBe(1);
    expect(failures).toBe(1);
    expect(oracle.renderer.isDestroyed).toBe(true);
  } finally {
    handle?.release();
    Reflect.set(oracle.renderer, "renderNative", originalWriter);
    oracle.dispose();
    process.stderr.write = originalStderr;
  }
});

test("a title queued during startup uses its capability with controls removed", async () => {
  const oracle = await createTerminalOracle({ width: 60, height: 20 });
  const titles: string[] = [];
  oracle.renderer.setTerminalTitle = (title) => {
    titles.push(title);
  };
  let acquire: ((value: MountedRenderer) => void) | undefined;
  const handle = mountFullscreenApp({
    mount: () =>
      new Promise((resolve) => {
        acquire = resolve;
      }),
  });
  try {
    handle.setTitle("first");
    handle.setTitle("Jazz\x07\x1b[2J\n");
    expect(titles).toEqual([]);
    acquire?.({ renderer: oracle.renderer, release: () => oracle.dispose() });
    await Bun.sleep(0);
    await oracle.renderer.idle();
    expect(titles).toEqual(["Jazz[2J"]);
    handle.setTitle("next");
    expect(titles).toEqual(["Jazz[2J", "next"]);
    handle.release();
    handle.setTitle("after release");
    expect(titles).toHaveLength(2);
  } finally {
    handle.release();
    oracle.dispose();
  }
});

test("a live terminal capability failure hands off once instead of escaping the caller", async () => {
  const oracle = await createTerminalOracle({ width: 60, height: 20 });
  const failure = new Error("native title failed");
  const originalStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let resolveFailure: ((error: unknown) => void) | undefined;
  const failed = new Promise<unknown>((resolve) => {
    resolveFailure = resolve;
  });
  let failures = 0;
  const handle = mountFullscreenApp({
    mount: async () => ({ renderer: oracle.renderer, release: () => oracle.dispose() }),
    onFailure: (error) => {
      failures++;
      resolveFailure?.(error);
    },
  });
  try {
    await Bun.sleep(0);
    await oracle.renderer.idle();
    oracle.renderer.setTerminalTitle = () => {
      throw failure;
    };
    expect(() => handle.setTitle("new title")).not.toThrow();
    expect(() => handle.setTitle("another title")).not.toThrow();
    expect(await failed).toBe(failure);
    expect(failures).toBe(1);
    expect(oracle.renderer.isDestroyed).toBe(true);
  } finally {
    handle.release();
    oracle.dispose();
    process.stderr.write = originalStderr;
  }
});

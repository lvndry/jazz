/**
 * Owns the terminal for the fullscreen interface.
 *
 * The classic failure of every alternate-screen app is crashing and leaving the
 * user with a hidden cursor, no echo and mouse reporting still on. OpenTUI
 * already handles most of that contract — its constructor registers listeners
 * for the configured exit signals plus `uncaughtException` and
 * `unhandledRejection`, and `createCliRenderer` wraps terminal setup in a
 * try/catch that destroys the renderer if setup throws partway. So this module
 * configures those primitives and scopes the additional resources OpenTUI
 * leaves to the caller: job control, synchronous exit restoration, foreign
 * stream capture, theme-ground synchronization and physical resize invalidation.
 * Native and React mutations schedule demand frames; startup never installs a
 * perpetual render loop. mountFullscreen returns the native renderer and its
 * idempotent release. The capability decision lives in terminal-capabilities.ts,
 * so Ink and plain paths can choose without loading OpenTUI.
 */

import { writeSync } from "node:fs";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { store } from "../store";
import { REVEAL_FRAME_MS } from "../text/stream-pacer";
import { applyTerminalPalette, groundIsPainted, onThemeChange, THEME } from "../theme";
import type { OutputEntry } from "../types";
import { rendererInvalidation } from "./renderer-adapter";
import { TerminalScope } from "./terminal-scope";

export interface MountedRenderer {
  readonly renderer: CliRenderer;
  /** Idempotent. Safe to call from a signal handler or twice. */
  readonly release: () => void;
}

/**
 * Frame cap. Deliberately not 60.
 *
 * The renderer paints only when something changed, so this is a ceiling, not a
 * loop: an idle screen paints nothing, and the activity indicator keeps its own
 * slow interval (`MOTION.indicator`). The one thing that asks for more is
 * streamed prose, which the reveal pacer advances once per `REVEAL_FRAME_MS`;
 * at 12fps each frame would add half a line and read as steps. At least one
 * popular terminal allocates a buffer per synchronized frame, so the cap stays
 * at the reveal rate rather than going higher.
 */
const MAX_FPS = Math.round(1000 / REVEAL_FRAME_MS);

/** The renderer surface the lifecycle drives, narrowed so tests can pass a stand-in. */
export type LifecycleRenderer = Pick<
  CliRenderer,
  "destroy" | "suspend" | "resume" | "requestRender" | "resetTerminalBgColor" | "isDestroyed"
>;

/** The slice of `process` the lifecycle listens on, for the same reason. */
export interface LifecycleProcess {
  readonly pid: number;
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
  kill(pid: number, signal: string): unknown;
}

/**
 * Wires the renderer to the process events OpenTUI does not own, and returns the
 * idempotent release.
 *
 * Two of those events matter. Job control is the one OpenTUI documents as the
 * caller's: on suspend the terminal must be handed back before the process
 * stops, or the shell resumes into a broken screen; on continue we re-enter and
 * repaint.
 *
 * `exit` is the one it silently leaves open. OpenTUI installs handlers for the
 * configured exit signals and for uncaught errors, but never for `process.exit`
 * — so a plain exit tears the process down with mouse reporting and the
 * alternate screen still on, and the shell that gets the terminal back prints
 * every mouse move as a stray `35;97;18M`. jazz reaches exactly that path on a
 * normal quit, where the wizard ends on `process.exit(0)` and Effect's
 * finalizers (which is where the terminal cleanup lives) never run.
 *
 * Both job-control handlers check `isDestroyed` as well as `released`, because
 * OpenTUI destroys the renderer from its own signal handlers without telling us:
 * `exitHandler` is just `destroy()`, and it does not exit the process, so a
 * first Ctrl+C leaves a destroyed renderer while jazz runs its graceful
 * shutdown. `destroy()` also restores ISIG, so a ^Z in that window arrives as a
 * real SIGTSTP. Neither `suspend()` nor `resume()` checks `isDestroyed` itself,
 * and `destroy()` does not null `rendererPtr` — so an unguarded handler would
 * call into a freed renderer, and `resume()` would re-enter raw mode and start
 * the terminal keep-alive with no TUI left to run.
 *
 * Exit listeners may only do synchronous work. `destroy()` is synchronous here
 * because it defers to `finalizeDestroy()` only while `rendering` is true, which
 * needs a registered frame callback, and jazz registers none. Were that to
 * change, the deferred path still runs `cleanupBeforeDestroy()` — which is what
 * disables mouse reporting — so only the alternate-screen restore would be lost.
 */
export function installTerminalLifecycle(
  renderer: LifecycleRenderer,
  runtime: LifecycleProcess = process,
  afterResume: () => void = () => undefined,
): () => void {
  let released = false;
  const scope = new TerminalScope();
  scope.add(() => {
    if (!renderer.isDestroyed) renderer.destroy();
  });

  const onSuspend = (): void => {
    if (released || renderer.isDestroyed) return;
    renderer.resetTerminalBgColor();
    renderer.suspend();
    runtime.kill(runtime.pid, "SIGSTOP");
  };
  const onContinue = (): void => {
    if (released || renderer.isDestroyed) return;
    renderer.resume();
    afterResume();
    renderer.requestRender();
  };
  const onExit = (): void => {
    release();
  };

  function release(): void {
    if (released) return;
    released = true;
    scope.release();
  }

  try {
    for (const [event, listener] of [
      ["SIGTSTP", onSuspend],
      ["SIGCONT", onContinue],
      ["exit", onExit],
    ] as const) {
      runtime.on(event, listener);
      scope.add(() => {
        runtime.off(event, listener);
      });
    }
  } catch (error) {
    try {
      release();
    } catch {
      /* All resources were attempted. */
    }
    throw error;
  }

  return release;
}

/** The slice of a stdio stream the guard replaces, so tests can pass a stand-in. */
export interface GuardedStream {
  write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean;
}

/** Foreign output is transcript text, never permission to change terminal modes or cells. */
export function transcriptTextForForeignWrite(chunk: string): string | null {
  const plain = stripAnsiCodes(chunk).replace(/\p{Cc}/gu, (character) =>
    character === "\n" || character === "\r" || character === "\t" ? character : "",
  );
  for (const character of plain) {
    const code = character.codePointAt(0) ?? 0;
    // Space and below occupy no ink; DEL occupies no column.
    if (code > 0x20 && code !== 0x7f) return plain.replace(/\r?\n+$/, "");
  }
  return null;
}

/**
 * Capture foreign stdout/stderr while the renderer owns the terminal. Native
 * frames and explicit renderer capabilities use the writer captured before this
 * guard. Foreign controls, whitespace and recursive sink logging are suppressed;
 * visible text becomes a transcript entry. This fences JavaScript stream writes,
 * not trusted native code or children handed the terminal file descriptor.
 */
export function guardOutput(
  renderer: Pick<CliRenderer, "isDestroyed">,
  sink: (entry: OutputEntry) => unknown = store.printOutput,
  streams: { readonly out: GuardedStream; readonly err: GuardedStream } = {
    out: process.stdout,
    err: process.stderr,
  },
): () => void {
  let reentrant = false;
  let restored = false;

  const guard = (stream: GuardedStream, entry: (message: string) => OutputEntry): (() => void) => {
    const writer: unknown = Reflect.get(stream, "write");
    const original = writer as GuardedStream["write"];
    const guarded = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      if (renderer.isDestroyed) return original.call(stream, chunk, encoding, callback);
      const text =
        typeof chunk === "string"
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8")
            : String(chunk);
      const line = transcriptTextForForeignWrite(text);
      if (!reentrant && line !== null) {
        reentrant = true;
        try {
          sink(entry(line));
        } finally {
          reentrant = false;
        }
      }
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") process.nextTick(done);
      return true;
    };
    stream.write = guarded;

    return () => {
      if (stream.write === guarded) stream.write = original;
    };
  };

  const restore = [
    guard(streams.out, (message) => ({ type: "log", message, timestamp: new Date() })),
    // stderr is not the rarer case it looks: the AI SDK's warning banner goes
    // through `console.error` by deliberate choice (see runtime/src/main.ts),
    // and stderr paints the alternate screen exactly as stdout does.
  ];
  if (streams.err !== streams.out) {
    restore.push(
      guard(streams.err, (message) => ({ type: "warn", message, timestamp: new Date() })),
    );
  }

  return () => {
    if (restored) return;
    restored = true;
    for (let index = restore.length - 1; index >= 0; index--) restore[index]?.();
  };
}

/** The renderer surface the repaint hook drives, narrowed so tests can pass a stand-in. */
export interface RepaintableRenderer {
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
  requestRender(): void;
}

/** Resize invalidates the physical terminal grid, including cells unchanged in native buffers. */
export function repaintAfterResize(renderer: RepaintableRenderer): () => void {
  const { invalidate } = rendererInvalidation(renderer);
  const onResize = (): void => {
    invalidate();
  };

  renderer.on("resize", onResize);
  return () => {
    renderer.off("resize", onResize);
  };
}

/** OSC 111: reset the terminal's default background to the one its user configured. */
const RESET_TERMINAL_BACKGROUND = "\x1b]111\x07";

/** OSC 11: set the terminal's default background. */
export function setTerminalBackgroundSequence(hex: string): string {
  return `\x1b]11;${hex}\x07`;
}

/** The renderer surface the ground sync drives, narrowed so tests can pass a stand-in. */
export type GroundRenderer = Pick<
  CliRenderer,
  "setBackgroundColor" | "resetTerminalBgColor" | "requestRender" | "isDestroyed"
>;

export interface GroundSync {
  /** Paint the current mode's ground now, as after a resume. */
  readonly apply: () => void;
  readonly stop: () => void;
}

/**
 * Keep the renderer's clear colour and the terminal's own background in step with the theme.
 *
 * While the ground is painted, every cell the tree leaves empty is cleared to the theme's
 * background and the terminal's default background is set to match, so the padding a terminal
 * draws around its grid and any row the renderer has not reached yet agree with the frame. While
 * it is inherited, the clear colour is transparent and the terminal's background is reset to
 * whatever the user configured. A resume calls `apply` to set it again.
 *
 * Once a background has been set, process exit — a quit, a crash, a signal — resets it with a
 * synchronous write: the reset OpenTUI's `destroy()` sends does not reach the terminal on a
 * quit, which then keeps jazz's background at the shell prompt.
 *
 * Either way a change forces a full repaint: every cell's background may have changed, and the
 * renderer's diff would otherwise skip cells whose glyph did not.
 */
export function syncTerminalGround(
  renderer: GroundRenderer,
  write: (data: string) => void = (data) => {
    writeSync(process.stdout.fd, data);
  },
  runtime: Pick<LifecycleProcess, "on" | "off"> = process,
): GroundSync {
  const { invalidate } = rendererInvalidation(renderer);
  let terminalBackgroundSet = false;
  let stopped = false;
  const apply = (): void => {
    if (stopped || renderer.isDestroyed) return;
    if (groundIsPainted()) {
      renderer.setBackgroundColor(THEME.background);
      write(setTerminalBackgroundSequence(THEME.background));
      terminalBackgroundSet = true;
    } else {
      renderer.setBackgroundColor("transparent");
      renderer.resetTerminalBgColor();
    }
    invalidate();
  };
  const onExit = (): void => {
    if (terminalBackgroundSet) {
      write(RESET_TERMINAL_BACKGROUND);
    }
  };
  const scope = new TerminalScope();
  scope.add(onExit);
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    scope.release();
  };
  try {
    scope.add(onThemeChange(apply));
    runtime.on("exit", onExit);
    scope.add(() => {
      runtime.off("exit", onExit);
    });
    apply();
    return { apply, stop };
  } catch (error) {
    try {
      stop();
    } catch {
      /* All resources were attempted. */
    }
    throw error;
  }
}

/** How long the first frame waits for the terminal to report its colours. */
const PALETTE_QUERY_TIMEOUT_MS = 100;

/** The ANSI slots the `system` theme reads from. */
const PALETTE_QUERY_SIZE = 16;

export type PaletteSource = Pick<CliRenderer, "getPalette">;

/**
 * Ask the terminal for its background, foreground and ANSI colours (OSC 10, 11 and 4), and hand
 * the answer to the theme: it picks the variant, derives the tiers in `inherit` mode, and builds
 * the `system` theme. A terminal that does not answer within the timeout keeps the variant
 * `COLORFGBG` suggested and the house palette.
 */
export async function detectTerminalColors(renderer: PaletteSource): Promise<void> {
  try {
    const colors = await renderer.getPalette({
      timeout: PALETTE_QUERY_TIMEOUT_MS,
      size: PALETTE_QUERY_SIZE,
    });
    applyTerminalPalette(colors);
  } catch {
    // No answer, or a renderer that cannot query: the environment's guess stands.
  }
}

export async function mountFullscreen(): Promise<MountedRenderer> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    // jazz bridges Ctrl+C to a real SIGINT itself so the agent loop can cancel
    // in-flight work; letting the renderer exit the process would skip that.
    exitOnCtrlC: false,
    exitSignals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"],
    maxFps: MAX_FPS,
    // Wheel events only arrive with mouse reporting on. OpenTUI has no
    // wheel-only mode; this also replaces the terminal's native drag-select
    // with OpenTUI's own selection (text is selectable by default). Releasing
    // that highlight copies it; Cmd+C does the same when the host forwards it.
    // Shift+drag still reaches native selection in many hosts.
    useMouse: true,
    // Leave whatever was on the main screen alone; the alternate screen restores
    // it on exit, and clearing it would destroy the user's scrollback.
    clearOnShutdown: false,
  });

  const scope = new TerminalScope();
  scope.add(() => {
    if (!renderer.isDestroyed) renderer.destroy();
  });
  const release = (): void => {
    scope.release();
  };
  try {
    scope.add(guardOutput(renderer));
    await detectTerminalColors(renderer);
    if (renderer.isDestroyed) throw new Error("Terminal renderer stopped during startup");
    const ground = syncTerminalGround(renderer);
    scope.add(ground.stop);
    scope.add(installTerminalLifecycle(renderer, process, ground.apply));
    scope.add(repaintAfterResize(renderer));
    return { renderer, release };
  } catch (error) {
    try {
      release();
    } catch {
      // Startup's original failure determines fallback; every cleanup was attempted.
    }
    throw error;
  }
}

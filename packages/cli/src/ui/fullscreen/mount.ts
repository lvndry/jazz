/**
 * Owns the terminal for the fullscreen interface.
 *
 * The classic failure of every alternate-screen app is crashing and leaving the
 * user with a hidden cursor, no echo and mouse reporting still on. OpenTUI
 * already handles most of that contract — its constructor registers listeners
 * for the configured exit signals plus `uncaughtException` and
 * `unhandledRejection`, and `createCliRenderer` wraps terminal setup in a
 * try/catch that destroys the renderer if setup throws partway. So this module
 * deliberately does not reimplement any of it; it configures it, and adds the
 * three things OpenTUI leaves to the caller: job control, restoring the terminal
 * when the process exits without a signal, and the decision about whether to
 * take over the screen at all.
 */

import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { MIN_HEIGHT, MIN_WIDTH } from "./types";
import { store } from "../store";
import type { OutputEntry } from "../types";

/** Why the fullscreen interface declined to start, when it does. */
export type PlainReason =
  "not-a-tty" | "ci" | "dumb-terminal" | "screen-reader" | "too-small" | "requested";

export interface CapabilityDecision {
  readonly fullscreen: boolean;
  readonly reason?: PlainReason;
  readonly width: number;
  readonly height: number;
}

export interface FullscreenEnvironment {
  readonly CI?: string;
  readonly TERM?: string;
  readonly INK_SCREEN_READER?: string;
  readonly JAZZ_A11Y?: string;
}

export interface TerminalOutputCapabilities {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export interface TerminalInputCapabilities {
  readonly isTTY?: boolean;
}

/**
 * Fullscreen is opt-out, not opt-in, but it turns itself off wherever it would
 * be actively worse than plain output. None of these are flags a user has to
 * discover.
 *
 * The screen-reader case is not negotiable: an alternate screen with live
 * repaint re-announces the same region endlessly, which is hostile rather than
 * merely imperfect.
 */
export function decideFullscreen(
  options: { requestPlain?: boolean } = {},
  environment: FullscreenEnvironment = process.env as FullscreenEnvironment,
  stdout: TerminalOutputCapabilities = process.stdout,
  stdin: TerminalInputCapabilities = process.stdin,
): CapabilityDecision {
  const width = stdout.columns ?? 0;
  const height = stdout.rows ?? 0;
  const base = { width, height };

  if (options.requestPlain === true) return { ...base, fullscreen: false, reason: "requested" };
  if (stdout.isTTY !== true || stdin.isTTY !== true) {
    return { ...base, fullscreen: false, reason: "not-a-tty" };
  }
  if (environment.CI !== undefined && environment.CI !== "") {
    return { ...base, fullscreen: false, reason: "ci" };
  }
  const term = (environment.TERM ?? "").toLowerCase();
  if (term === "" || term === "dumb") {
    return { ...base, fullscreen: false, reason: "dumb-terminal" };
  }
  if (environment.INK_SCREEN_READER === "1" || environment.JAZZ_A11Y === "1") {
    return { ...base, fullscreen: false, reason: "screen-reader" };
  }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { ...base, fullscreen: false, reason: "too-small" };
  }
  return { ...base, fullscreen: true };
}

/** What to tell the user when fullscreen stands down, or nothing when it is obvious. */
export function explainPlain(reason: PlainReason, width: number, height: number): string | null {
  switch (reason) {
    case "too-small":
      return `jazz needs ${MIN_WIDTH}x${MIN_HEIGHT}; this terminal is ${width}x${height}. Resize, or keep using plain output.`;
    case "screen-reader":
      return "Screen reader detected — using plain append-only output, which reads one line per state change.";
    case "not-a-tty":
    case "ci":
    case "dumb-terminal":
    case "requested":
      return null;
  }
}

export interface MountedRenderer {
  readonly renderer: CliRenderer;
  /** Idempotent. Safe to call from a signal handler or twice. */
  readonly release: () => void;
}

/**
 * Frame budget. Deliberately not 60.
 *
 * The fastest host TUIs are invalidation-driven on a ~250ms heartbeat and run no
 * animation loop at all, and at least one popular terminal allocates a buffer
 * per synchronized frame — so a high frame rate costs the host real work to
 * produce motion nobody asked for. 12fps is enough for the indicator and
 * cheap everywhere.
 */
const MAX_FPS = 12;

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
): () => void {
  let released = false;

  const onSuspend = (): void => {
    if (released || renderer.isDestroyed) return;
    renderer.resetTerminalBgColor();
    renderer.suspend();
    runtime.kill(runtime.pid, "SIGSTOP");
  };
  const onContinue = (): void => {
    if (released || renderer.isDestroyed) return;
    renderer.resume();
    renderer.requestRender();
  };
  const onExit = (): void => {
    release();
  };

  function release(): void {
    if (released) return;
    released = true;
    runtime.off("SIGTSTP", onSuspend);
    runtime.off("SIGCONT", onContinue);
    runtime.off("exit", onExit);
    if (!renderer.isDestroyed) renderer.destroy();
  }

  runtime.on("SIGTSTP", onSuspend);
  runtime.on("SIGCONT", onContinue);
  runtime.on("exit", onExit);

  return release;
}

/** The slice of a stdio stream the guard replaces, so tests can pass a stand-in. */
export interface GuardedStream {
  write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean;
}

/**
 * What a foreign write should show in the transcript, or null when it is pure
 * terminal control — an OSC title, a mode toggle — which paints no cells and
 * can go straight through.
 */
export function transcriptTextForForeignWrite(chunk: string): string | null {
  for (const character of stripAnsiCodes(chunk)) {
    const code = character.codePointAt(0) ?? 0;
    // Space and below occupy no ink; DEL occupies no column.
    if (code > 0x20 && code !== 0x7f) return chunk.replace(/\r?\n+$/, "");
  }
  return null;
}

/**
 * Keep the screen the renderer's alone.
 *
 * OpenTUI paints the alternate screen by diffing against its own model of what
 * is already on it, and it writes frames through a reference to the real
 * `write` captured when the renderer was constructed — never through
 * `process.stdout.write`. So anything else that writes changes the screen
 * without the model knowing, and from then on every frame skips the cells it
 * wrongly believes are already correct. That desync is what a long session
 * shows as half-rows of two different strings interleaved and a trail of stale
 * live-band rows: not leaked state (the band is clamped to LIVE_ZONE_MAX_ROWS,
 * and no single frame can hold the rows on screen), but old cells nothing ever
 * repainted. OpenTUI guards against this only in `split-footer` mode, via
 * `externalOutputMode: "capture-stdout"`, which the alternate screen refuses.
 *
 * Installed after `createCliRenderer` precisely so the renderer's captured
 * reference stays the untouched one: frames bypass this, and what arrives here
 * is by definition somebody else's output. It goes to the transcript, where it
 * is visible instead of destructive — nothing is swallowed.
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

  const guard = (stream: GuardedStream, entry: (message: string) => OutputEntry): (() => void) => {
    const original = stream.write.bind(stream);
    stream.write = (chunk: unknown, encoding?: unknown, callback?: unknown) => {
      const passthrough = (): boolean => original(chunk, encoding, callback);
      // Once the renderer is gone the screen is the shell's again and writing to
      // it is the correct thing to do — which is what makes a crash message,
      // printed after OpenTUI's own handlers destroy the renderer, still arrive.
      if (reentrant || renderer.isDestroyed) return passthrough();

      const line = transcriptTextForForeignWrite(typeof chunk === "string" ? chunk : String(chunk));
      if (line === null) return passthrough();

      reentrant = true;
      try {
        sink(entry(line));
      } finally {
        reentrant = false;
      }
      const done = typeof encoding === "function" ? encoding : callback;
      if (typeof done === "function") process.nextTick(done);
      return true;
    };

    return () => {
      stream.write = original;
    };
  };

  const restore = [
    guard(streams.out, (message) => ({ type: "log", message, timestamp: new Date() })),
    // stderr is not the rarer case it looks: the AI SDK's warning banner goes
    // through `console.error` by deliberate choice (see runtime/src/main.ts),
    // and stderr paints the alternate screen exactly as stdout does.
    guard(streams.err, (message) => ({ type: "warn", message, timestamp: new Date() })),
  ];

  return () => {
    for (const undo of restore) undo();
  };
}

/** The renderer surface the repaint hook drives, narrowed so tests can pass a stand-in. */
export interface RepaintableRenderer {
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
  requestRender(): void;
}

/**
 * Repaint everything after the terminal changes size.
 *
 * `processResize` reallocates the buffers but, outside `split-footer` mode,
 * never clears them and never asks for a full repaint — so the next frame is
 * diffed against cells whose relationship to the physical screen the resize has
 * just broken. Terminals reflow or truncate their own grid, OpenTUI crops its
 * buffer, and wherever the two disagree the diff skips the cell and the old
 * glyph stays: the same desync a foreign write causes, arriving through another
 * door. It needs nobody to drag a window — a display change while the machine
 * sleeps (the lid, an external monitor, a window restored at another size) is a
 * resize the user never typed, which is why this shows up as "it was fine when
 * I left it".
 *
 * `forceFullRepaintRequested` is the flag OpenTUI sets for itself on resume and
 * on a capability response, and it is private — so this checks for it and does
 * nothing if a later version renames it. A missing repaint is the bug that is
 * already there, not a new one.
 *
 * ponytail: reaching into a private field, because the public API has no
 * "repaint everything". Drop this the day OpenTUI exposes one, or resizes with
 * the same force it resumes with.
 */
export function repaintAfterResize(renderer: RepaintableRenderer): () => void {
  const onResize = (): void => {
    const internals = renderer as unknown as { forceFullRepaintRequested?: boolean };
    if (typeof internals.forceFullRepaintRequested !== "boolean") return;
    internals.forceFullRepaintRequested = true;
    renderer.requestRender();
  };

  renderer.on("resize", onResize);
  return () => {
    renderer.off("resize", onResize);
  };
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

  const release = installTerminalLifecycle(renderer);
  const stopGuard = guardOutput(renderer);
  const stopRepaint = repaintAfterResize(renderer);

  renderer.start();
  return {
    renderer,
    release: () => {
      stopRepaint();
      stopGuard();
      release();
    },
  };
}

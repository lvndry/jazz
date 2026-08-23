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
 * two things OpenTUI leaves to the caller: job control, and the decision about
 * whether to take over the screen at all.
 */

import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { MIN_HEIGHT, MIN_WIDTH } from "./types";

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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed under tsconfig.test.json, where Bun's stricter globals apply
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

  let released = false;

  // Job control is the one part of the lifecycle OpenTUI leaves to the caller.
  // On suspend the terminal must be handed back before the process stops, or the
  // shell resumes into a broken screen; on continue we re-enter and repaint.
  const onSuspend = (): void => {
    if (released) return;
    renderer.resetTerminalBgColor();
    renderer.suspend();
    process.kill(process.pid, "SIGSTOP");
  };
  const onContinue = (): void => {
    if (released) return;
    renderer.resume();
    renderer.requestRender();
  };

  process.on("SIGTSTP", onSuspend);
  process.on("SIGCONT", onContinue);

  const release = (): void => {
    if (released) return;
    released = true;
    process.off("SIGTSTP", onSuspend);
    process.off("SIGCONT", onContinue);
    if (!renderer.isDestroyed) renderer.destroy();
  };

  renderer.start();
  return { renderer, release };
}

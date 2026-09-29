/**
 * Whether the fullscreen interface can take over this terminal, decided before any renderer
 * loads. It sits outside `ui/fullscreen/` so the Ink and plain paths can ask without
 * importing OpenTUI.
 */

import { MIN_HEIGHT, MIN_WIDTH } from "./fullscreen/types";

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

/** A screen reader is in use: Ink renders, and text is never paced or animated. */
export function screenReaderRequested(
  environment: Pick<
    FullscreenEnvironment,
    "INK_SCREEN_READER" | "JAZZ_A11Y"
  > = process.env as FullscreenEnvironment,
): boolean {
  return environment.INK_SCREEN_READER === "1" || environment.JAZZ_A11Y === "1";
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
  if (screenReaderRequested(environment)) {
    return { ...base, fullscreen: false, reason: "screen-reader" };
  }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return { ...base, fullscreen: false, reason: "too-small" };
  }
  return { ...base, fullscreen: true };
}

/**
 * How much a turn thought, folded to one line. A turn that reasons before each
 * of five tool calls used to leave five "Reasoning · 1.2s" lines between its
 * receipts; both renderers now show one, when the turn settles:
 *
 *   › thought for 9.6s across 5 steps · ctrl+r to read
 *
 * Pure, so the store (which prints the line into the scrollback both renderers
 * read) and the fullscreen transcript (which draws folded and opened reasoning
 * blocks) cannot disagree about the wording.
 */

export interface TurnThought {
  readonly steps: number;
  readonly durationMs: number;
  /** The reasoning text of each step that returned any, in order. */
  readonly texts: readonly string[];
  readonly tokens?: number;
}

export const NO_THOUGHT: TurnThought = { steps: 0, durationMs: 0, texts: [] };

export function addThoughtStep(
  thought: TurnThought,
  step: { readonly durationMs: number; readonly text?: string; readonly tokens?: number },
): TurnThought {
  const text = step.text?.trim() ?? "";
  const tokens =
    thought.tokens === undefined && step.tokens === undefined
      ? undefined
      : (thought.tokens ?? 0) + (step.tokens ?? 0);
  return {
    steps: thought.steps + 1,
    durationMs: thought.durationMs + Math.max(0, step.durationMs),
    texts: text.length > 0 ? [...thought.texts, text] : thought.texts,
    ...(tokens === undefined ? {} : { tokens }),
  };
}

/** Everything the turn thought, as one text to read. */
export function thoughtText(thought: TurnThought): string {
  return thought.texts.join("\n\n");
}

/** Tenths under a minute (`4.1s`), then minutes and seconds (`2m 5s`). */
export function formatPreciseDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1_000) return `${String(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
}

/** `thought for 9.6s across 5 steps`: the duration, and the step count once there is more than one. */
export function thoughtLabel(thought: {
  readonly durationMs?: number;
  readonly steps?: number;
}): string {
  const duration =
    thought.durationMs === undefined ? "" : ` for ${formatPreciseDuration(thought.durationMs)}`;
  const steps = thought.steps ?? 1;
  return `thought${duration}${steps > 1 ? ` across ${String(steps)} steps` : ""}`;
}

/**
 * The folded line: the label, and the key that opens it when there is text to
 * read. `marker` is the renderer's disclosure glyph (`›`, or `>` in ASCII).
 */
export function foldedThoughtLine(
  thought: { readonly durationMs?: number; readonly steps?: number },
  hasText: boolean,
  marker: string,
  separator: string,
): string {
  return `${marker} ${thoughtLabel(thought)}${hasText ? `${separator}ctrl+r to read` : ""}`;
}

import { getGlyphs } from "./glyphs";
import { CHALK_THEME } from "./theme";

/** Columns consumed by the speaker rail (`▍ ` / `| `). */
export const RAIL_WIDTH = 2;

/**
 * Prefix every line of a pre-wrapped block with the speaker rail — the
 * transcript's color-coded left edge (brass = you, cyan = agent,
 * indigo = reasoning). Applied to both the live pending tail and settled
 * scrollback slices so streaming and settled output look identical.
 */
export function railStreamLines(wrapped: string, kind: unknown): string {
  const railColor = kind === "reasoning" ? CHALK_THEME.reasoning : CHALK_THEME.agent;
  const rail = railColor(getGlyphs().rail) + " ";
  return wrapped
    .split("\n")
    .map((line) => rail + line)
    .join("\n");
}

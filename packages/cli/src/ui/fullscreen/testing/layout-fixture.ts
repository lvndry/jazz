/**
 * Explicit exhaustive layout fixture for assertions. Each caller owns its layout
 * instance; reset replaces it so incremental-vs-fresh tests share no derived data.
 * Production selects a bounded window directly from TranscriptLayoutIndex.
 */
import { getGlyphs } from "../../glyphs";
import { getThemeRevision, THEME } from "../../theme";
import { createTranscriptLayout, type TranscriptRow } from "../transcript-layout";
import type { Block, Viewport } from "../types";

export function createLayoutFixture(): {
  readonly rows: (blocks: readonly Block[], viewport: Viewport) => readonly TranscriptRow[];
  readonly reset: () => void;
} {
  let layout = createTranscriptLayout();
  return {
    rows: (blocks, viewport) =>
      layout
        .update(blocks, {
          width: viewport.width,
          glyphs: getGlyphs(),
          themeRevision: getThemeRevision(),
          colors: THEME,
        })
        .flatten(),
    reset: () => {
      layout.dispose();
      layout = createTranscriptLayout();
    },
  };
}

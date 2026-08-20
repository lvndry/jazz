/** @jsxImportSource @opentui/react */

/**
 * The footer: one row of what you can do next, plus what this is costing.
 *
 *   plan house ∙ tab accept ∙ ctrl+r search        $0.42 ∙ 1m 35s
 *
 * The hints are a priority queue, not a fixed strip: at a narrow width the row
 * gives up the least useful thing rather than wrapping. Mode and cost never
 * drop — the first because acting without knowing the mode is how you get a
 * surprise, the second because a spend you cannot see is a spend you cannot
 * stop. The personality dial sits beside the mode, dim, so the voice reads as
 * something you set rather than something imposed on you.
 */

import type { ReactNode } from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import type { FooterModel, Viewport } from "./types";

export interface FooterSegment {
  readonly text: string;
  readonly fg: string;
}

function cells(text: string): number {
  return [...text].length;
}

function segmentsWidth(segments: readonly FooterSegment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

function truncateSegments(
  segments: readonly FooterSegment[],
  max: number,
): readonly FooterSegment[] {
  const kept: FooterSegment[] = [];
  let remaining = Math.max(0, max);
  for (const segment of segments) {
    if (remaining === 0) break;
    const characters = [...segment.text];
    if (characters.length <= remaining) {
      kept.push(segment);
      remaining -= characters.length;
    } else {
      kept.push({ text: characters.slice(0, remaining).join(""), fg: segment.fg });
      remaining = 0;
    }
  }
  return kept;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Fit the row: drop elapsed first, then hints from the end. Everything sits on
 * the neutral ramp except the mode, which takes the one accent.
 */
export function footerSegments(model: FooterModel, viewport: Viewport): readonly FooterSegment[] {
  const glyphs = getGlyphs();
  const separator = ` ${glyphs.bullet} `;
  const separatorWidth = cells(separator);

  const mode: FooterSegment[] = [
    { text: model.mode, fg: THEME.primary },
    { text: ` ${model.personality}`, fg: THEME.muted },
  ];
  const cost =
    model.costUsd === undefined ? undefined : { text: formatCost(model.costUsd), fg: THEME.muted };
  const elapsed =
    model.elapsedMs === undefined
      ? undefined
      : { text: formatElapsed(model.elapsedMs), fg: THEME.muted };

  let hints = [...model.hints];
  let keepElapsed = elapsed !== undefined;

  const leftWidth = (): number =>
    segmentsWidth(mode) + hints.reduce((total, hint) => total + separatorWidth + cells(hint), 0);
  const rightWidth = (): number => {
    const parts: string[] = [];
    if (cost !== undefined) parts.push(cost.text);
    if (keepElapsed && elapsed !== undefined) parts.push(elapsed.text);
    if (parts.length === 0) return 0;
    return (
      parts.reduce((total, part) => total + cells(part), 0) + separatorWidth * (parts.length - 1)
    );
  };
  const total = (): number => {
    const right = rightWidth();
    return leftWidth() + (right > 0 ? 1 + right : 0);
  };

  if (total() > viewport.width && keepElapsed) keepElapsed = false;
  while (total() > viewport.width && hints.length > 0) hints = hints.slice(0, -1);

  const left: FooterSegment[] = [...mode];
  for (const hint of hints) {
    left.push({ text: separator, fg: THEME.muted });
    left.push({ text: hint, fg: THEME.secondary });
  }

  const right: FooterSegment[] = [];
  if (cost !== undefined) right.push(cost);
  if (keepElapsed && elapsed !== undefined) {
    if (right.length > 0) right.push({ text: separator, fg: THEME.muted });
    right.push(elapsed);
  }

  const fittedLeft = truncateSegments(left, Math.max(0, viewport.width - segmentsWidth(right)));
  const gap = Math.max(0, viewport.width - segmentsWidth(fittedLeft) - segmentsWidth(right));
  const padding: FooterSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return [...fittedLeft, ...padding, ...right];
}

export function Footer({ model, viewport }: { model: FooterModel; viewport: Viewport }): ReactNode {
  const segments = footerSegments(model, viewport);
  return (
    <box style={{ width: viewport.width, height: 1, flexShrink: 0 }}>
      <text>
        {segments.map((segment, index) => (
          <span
            key={`${String(index)}:${segment.text}`}
            style={{ fg: segment.fg }}
          >
            {segment.text}
          </span>
        ))}
      </text>
    </box>
  );
}

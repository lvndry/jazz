/** @jsxImportSource @opentui/react */

/**
 * The footer: one row of what you can do next, plus what this is costing.
 *
 *   safe ∙ enter to send ∙ up for history        20k/40k $0.18 ∙ 4:12
 *
 * The hints are a priority queue, not a fixed strip: at a narrow width the row
 * gives up the least useful thing rather than wrapping. Mode and spend never
 * drop — the first because acting without knowing the mode is how you get a
 * surprise, the second because a spend you cannot see is a spend you cannot
 * stop. Spend is billed input/output tokens plus estimated USD.
 */

import { memo, type ReactNode } from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import { fitTerminalSegments, terminalCellWidth, terminalSegmentsWidth } from "./terminal-cells";
import type { FooterModel, Viewport } from "./types";

export interface FooterSegment {
  readonly text: string;
  readonly fg: string;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(2)}`;
}

const COMPACT_SUFFIXES = ["k", "M", "B"] as const;

/**
 * Compact count for the footer: 100, 1k, 10k, 1M, 1B.
 * One decimal only below 10 of the current unit (`1.5k`, `1.5M`).
 */
export function formatCompactCount(value: number): string {
  let scaled = value;
  let unitIndex = -1;
  while (Math.abs(scaled) >= 1_000 && unitIndex < COMPACT_SUFFIXES.length - 1) {
    scaled /= 1_000;
    unitIndex += 1;
  }
  if (unitIndex < 0) return `${Math.round(value)}`;

  const rounded = Math.abs(scaled) < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
  if (Math.abs(rounded) >= 1_000 && unitIndex < COMPACT_SUFFIXES.length - 1) {
    const promoted = rounded / 1_000;
    unitIndex += 1;
    const suffix = COMPACT_SUFFIXES[unitIndex];
    const body = Number.isInteger(promoted) ? `${promoted}` : promoted.toFixed(1);
    return `${body}${suffix}`;
  }

  const suffix = COMPACT_SUFFIXES[unitIndex];
  const body = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${body}${suffix}`;
}

/** `20k/40k $0.26` — tokens when known, cost when known, both when both. */
export function formatUsage(model: {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly costUsd?: number;
}): string | undefined {
  const hasTokens = model.promptTokens !== undefined || model.completionTokens !== undefined;
  const tokens = hasTokens
    ? `${formatCompactCount(model.promptTokens ?? 0)}/${formatCompactCount(model.completionTokens ?? 0)}`
    : undefined;
  const cost = model.costUsd === undefined ? undefined : formatCost(model.costUsd);
  if (tokens !== undefined && cost !== undefined) return `${tokens} ${cost}`;
  return tokens ?? cost;
}

export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Fit the row: drop elapsed first, then hints from the end. Everything sits on
 * the neutral ramp except the mode and a transient notice, which take the one
 * accent.
 */
export function footerSegments(model: FooterModel, viewport: Viewport): readonly FooterSegment[] {
  const glyphs = getGlyphs();
  const separator = ` ${glyphs.bullet} `;
  const separatorWidth = terminalCellWidth(separator);

  const mode: FooterSegment[] = [
    { text: model.mode, fg: model.mode === "yolo" ? THEME.warning : THEME.primary },
  ];
  const usageText = formatUsage(model);
  const usage = usageText === undefined ? undefined : { text: usageText, fg: THEME.muted };
  const elapsed =
    model.elapsedMs === undefined
      ? undefined
      : { text: formatElapsed(model.elapsedMs), fg: THEME.muted };

  const notice = model.notice !== undefined && model.notice.length > 0 ? model.notice : undefined;
  let hints = notice === undefined ? [...model.hints] : [];
  let keepElapsed = elapsed !== undefined;

  const leftWidth = (): number => {
    const noticeWidth = notice === undefined ? 0 : separatorWidth + terminalCellWidth(notice);
    return (
      terminalSegmentsWidth(mode) +
      noticeWidth +
      hints.reduce((total, hint) => total + separatorWidth + terminalCellWidth(hint), 0)
    );
  };
  const rightWidth = (): number => {
    const parts: string[] = [];
    if (usage !== undefined) parts.push(usage.text);
    if (keepElapsed && elapsed !== undefined) parts.push(elapsed.text);
    if (parts.length === 0) return 0;
    return (
      parts.reduce((total, part) => total + terminalCellWidth(part), 0) +
      separatorWidth * (parts.length - 1)
    );
  };
  const total = (): number => {
    const right = rightWidth();
    return leftWidth() + (right > 0 ? 1 + right : 0);
  };

  if (total() > viewport.width && keepElapsed) keepElapsed = false;
  while (total() > viewport.width && hints.length > 0) hints = hints.slice(0, -1);

  const left: FooterSegment[] = [...mode];
  if (notice !== undefined) {
    left.push({ text: separator, fg: THEME.muted });
    left.push({ text: notice, fg: THEME.primary });
  }
  for (const hint of hints) {
    left.push({ text: separator, fg: THEME.muted });
    left.push({ text: hint, fg: THEME.secondary });
  }

  const right: FooterSegment[] = [];
  if (usage !== undefined) right.push(usage);
  if (keepElapsed && elapsed !== undefined) {
    if (right.length > 0) right.push({ text: separator, fg: THEME.muted });
    right.push(elapsed);
  }

  const fittedLeft = fitTerminalSegments(
    left,
    Math.max(0, viewport.width - terminalSegmentsWidth(right)),
  );
  const gap = Math.max(
    0,
    viewport.width - terminalSegmentsWidth(fittedLeft) - terminalSegmentsWidth(right),
  );
  const padding: FooterSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return [...fittedLeft, ...padding, ...right];
}

function FooterView({ model, viewport }: { model: FooterModel; viewport: Viewport }): ReactNode {
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

export const Footer = memo(FooterView);

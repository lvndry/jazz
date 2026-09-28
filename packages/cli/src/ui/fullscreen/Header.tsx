/** @jsxImportSource @opentui/react */

/**
 * The header: one row, four fact groups, never hidden.
 *
 *    jazz  model · host:port                     apps 3 of 4   ━━━━━━━━━━ 47%
 *
 * The restraint is the design. The name is set bold and the model sits beside
 * it in the muted tone, because together they answer "who am I talking to".
 * Health is flush right: connector health as a count rather than four names
 * with four status marks — a name appears only when that connector needs
 * something from you — then a thin line meter for the context window. No rule
 * underneath; the blank row below the header is the separation.
 */

import { memo, type ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { THEME } from "../theme";
import { fitTerminalSegments, terminalCellWidth, terminalSegmentsWidth } from "./terminal-cells";
import type { Connector, HeaderModel, Viewport } from "./types";

/**
 * Small enough to read as a gauge rather than as a progress bar. Both runs are
 * the same heavy line, so the meter is one quiet stroke whose lit part is the
 * accent and whose remainder is the border tone.
 */
const METER_CELLS = 10;

/** A context window filling up is worth noticing before it is a problem. */
const CONTEXT_WARN_PERCENT = 80;
const CONTEXT_ERROR_PERCENT = 92;

/** Cells between the name and the model, and between the right-hand facts. */
const NEAR_GAP = "  ";
const FAR_GAP = "   ";

export interface HeaderSegment {
  readonly text: string;
  readonly fg: string;
  readonly bold?: boolean;
}

export interface HeaderGroup {
  readonly key: "mark" | "model" | "connectors" | "meter";
  readonly segments: readonly HeaderSegment[];
}

export function contextPercent(used: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

/** The lit run of the meter: the accent while calm, then warning, then error. */
export function meterColor(percent: number): string {
  if (percent > CONTEXT_ERROR_PERCENT) return THEME.error;
  if (percent > CONTEXT_WARN_PERCENT) return THEME.warning;
  return THEME.primary;
}

/** Any use at all lights one cell, so a live session never looks like an empty gauge. */
export function meterFilledCells(percent: number): number {
  if (percent <= 0) {
    return 0;
  }
  return Math.max(1, Math.round((percent / 100) * METER_CELLS));
}

function meterGroup(model: HeaderModel, glyphs: GlyphSet): HeaderGroup {
  const percent = contextPercent(model.contextUsed, model.contextMax);
  const filled = meterFilledCells(percent);
  const fill = meterColor(percent);
  return {
    key: "meter",
    segments: [
      { text: glyphs.ruleHeavy.repeat(filled), fg: fill },
      { text: glyphs.ruleHeavy.repeat(METER_CELLS - filled), fg: THEME.border },
      { text: " ", fg: THEME.muted },
      { text: `${percent}%`, fg: percent > CONTEXT_WARN_PERCENT ? fill : THEME.muted },
    ],
  };
}

/**
 * A connector needing re-auth is nobody's fault, so it is a warning rather than
 * an error: the row is telling you a door is closed, not that something broke.
 */
function connectorsGroup(connectors: readonly Connector[]): HeaderGroup | undefined {
  if (connectors.length === 0) return undefined;
  const needsAction = connectors.filter((connector) => connector.status === "renew");
  const first = needsAction[0];
  if (first !== undefined) {
    const others = needsAction.length > 1 ? ` +${needsAction.length - 1}` : "";
    return {
      key: "connectors",
      segments: [{ text: `${first.name} renew${others}`, fg: THEME.warning }],
    };
  }
  const live = connectors.filter((connector) => connector.status === "live").length;
  return {
    key: "connectors",
    segments: [{ text: `apps ${live} of ${connectors.length}`, fg: THEME.muted }],
  };
}

/** The groups the header would draw at unlimited width. Never more than four. */
export function headerGroups(model: HeaderModel, glyphs: GlyphSet = getGlyphs()): HeaderGroup[] {
  const groups: HeaderGroup[] = [
    {
      key: "mark",
      segments: [{ text: " jazz", fg: THEME.selected, bold: true }],
    },
    {
      key: "model",
      segments: [
        { text: model.model, fg: THEME.muted },
        ...(model.localHost === undefined
          ? []
          : [
              { text: ` ${glyphs.bullet} `, fg: THEME.muted },
              { text: model.localHost, fg: THEME.muted },
            ]),
      ],
    },
  ];
  const connectors = connectorsGroup(model.connectors);
  if (connectors !== undefined) groups.push(connectors);
  groups.push(meterGroup(model, glyphs));
  return groups;
}

function joined(groups: readonly HeaderGroup[], gap: string): HeaderSegment[] {
  const segments: HeaderSegment[] = [];
  groups.forEach((group, index) => {
    if (index > 0) segments.push({ text: gap, fg: THEME.muted });
    segments.push(...group.segments);
  });
  return segments;
}

/**
 * The name and model on the left, health flush right, padded to exactly the
 * viewport. When the width runs out the host goes first, then the model, then
 * the connectors — identity you can recover from a key goes before health you
 * would act on, and the meter is the last thing standing.
 */
export function headerSegments(model: HeaderModel, viewport: Viewport): readonly HeaderSegment[] {
  const glyphs = getGlyphs();
  const groups = headerGroups(model, glyphs);
  const mark = groups[0];
  if (mark === undefined) return [];

  let modelGroup = groups.find((group) => group.key === "model");
  let right = groups.filter((group) => group.key === "connectors" || group.key === "meter");
  const markWidth = terminalSegmentsWidth(mark.segments);
  const width = (): number => {
    const leftWidth =
      markWidth +
      (modelGroup === undefined
        ? 0
        : terminalCellWidth(NEAR_GAP) + terminalSegmentsWidth(modelGroup.segments));
    const rightWidth = terminalSegmentsWidth(joined(right, FAR_GAP));
    return leftWidth + 1 + rightWidth + 1;
  };

  if (modelGroup !== undefined && model.localHost !== undefined && width() > viewport.width) {
    modelGroup = { ...modelGroup, segments: modelGroup.segments.slice(0, 1) };
  }
  if (width() > viewport.width) modelGroup = undefined;
  while (right.length > 1 && width() > viewport.width) right = right.slice(1);

  const left: HeaderSegment[] = [
    ...mark.segments,
    ...(modelGroup === undefined
      ? []
      : [{ text: NEAR_GAP, fg: THEME.muted }, ...modelGroup.segments]),
  ];
  // One cell of margin on the right mirrors the one before the name.
  const rightSegments: HeaderSegment[] = [
    ...joined(right, FAR_GAP),
    { text: " ", fg: THEME.muted },
  ];
  const rightWidth = terminalSegmentsWidth(rightSegments);
  const fittedRight =
    rightWidth > viewport.width
      ? fitTerminalSegments(rightSegments, viewport.width)
      : rightSegments;
  const leftBudget = Math.max(0, viewport.width - terminalSegmentsWidth(fittedRight));
  const fittedLeft = fitTerminalSegments(left, leftBudget);
  const gap = Math.max(
    0,
    viewport.width - terminalSegmentsWidth(fittedLeft) - terminalSegmentsWidth(fittedRight),
  );
  const padding: HeaderSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return [...fittedLeft, ...padding, ...fittedRight];
}

function HeaderView({ model, viewport }: { model: HeaderModel; viewport: Viewport }): ReactNode {
  const segments = headerSegments(model, viewport);
  return (
    <box style={{ width: viewport.width, height: 1, flexShrink: 0 }}>
      <text>
        {segments.map((segment, index) =>
          segment.bold === true ? (
            <b
              key={`${String(index)}:${segment.text}`}
              style={{ fg: segment.fg }}
            >
              {segment.text}
            </b>
          ) : (
            <span
              key={`${String(index)}:${segment.text}`}
              style={{ fg: segment.fg }}
            >
              {segment.text}
            </span>
          ),
        )}
      </text>
    </box>
  );
}

export const Header = memo(HeaderView);

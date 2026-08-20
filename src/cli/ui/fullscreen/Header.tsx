/** @jsxImportSource @opentui/react */

/**
 * The header: one row, four fact groups, never hidden.
 *
 *   ▎ jazz                    model ∙ apps 3 of 4 ∙ ████░░░░ 47%
 *
 * The restraint is the design. Version, cwd, reasoning level and raw token
 * counts are all things you look up once and then stop reading, so they live
 * behind a key; what stays on screen is what changes or what you would act on.
 * Connector health is therefore a count rather than four names with four status
 * marks — a name appears only when that connector needs something from you.
 */

import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../glyphs";
import { THEME } from "../theme";
import type { Connector, HeaderModel, Viewport } from "./types";

/** Small enough to read as a gauge rather than as a progress bar. */
const METER_CELLS = 8;

/** A context window filling up is worth noticing before it is a problem. */
const CONTEXT_WARN_PERCENT = 80;
const CONTEXT_ERROR_PERCENT = 92;

export interface HeaderSegment {
  readonly text: string;
  readonly fg: string;
}

export interface HeaderGroup {
  readonly key: "mark" | "model" | "connectors" | "meter";
  readonly segments: readonly HeaderSegment[];
}

function cells(text: string): number {
  return [...text].length;
}

function segmentsWidth(segments: readonly HeaderSegment[]): number {
  return segments.reduce((total, segment) => total + cells(segment.text), 0);
}

function truncateSegments(
  segments: readonly HeaderSegment[],
  max: number,
): readonly HeaderSegment[] {
  const kept: HeaderSegment[] = [];
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

export function contextPercent(used: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((used / max) * 100)));
}

export function meterColor(percent: number): string {
  if (percent > CONTEXT_ERROR_PERCENT) return THEME.error;
  if (percent > CONTEXT_WARN_PERCENT) return THEME.warning;
  return THEME.secondary;
}

function meterGroup(model: HeaderModel, glyphs: GlyphSet): HeaderGroup {
  const percent = contextPercent(model.contextUsed, model.contextMax);
  const filled = Math.round((percent / 100) * METER_CELLS);
  const fill = meterColor(percent);
  return {
    key: "meter",
    segments: [
      { text: glyphs.gridFilled.repeat(filled), fg: fill },
      { text: glyphs.gridEmpty.repeat(METER_CELLS - filled), fg: THEME.border },
      { text: " ", fg: THEME.muted },
      { text: `${percent}%`, fg: fill },
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
    segments: [{ text: `apps ${live} of ${connectors.length}`, fg: THEME.secondary }],
  };
}

/** The groups the header would draw at unlimited width. Never more than four. */
export function headerGroups(model: HeaderModel, glyphs: GlyphSet = getGlyphs()): HeaderGroup[] {
  const groups: HeaderGroup[] = [
    {
      key: "mark",
      segments: [
        { text: glyphs.rail, fg: THEME.primary },
        { text: " jazz", fg: THEME.selected },
      ],
    },
    { key: "model", segments: [{ text: model.model, fg: THEME.secondary }] },
  ];
  const connectors = connectorsGroup(model.connectors);
  if (connectors !== undefined) groups.push(connectors);
  groups.push(meterGroup(model, glyphs));
  return groups;
}

/**
 * The mark is left-aligned, the facts are flush right, and the row is padded to
 * exactly the viewport. Facts drop from the left when the width runs out —
 * identity you can recover from a key goes before health you would act on.
 */
export function headerSegments(model: HeaderModel, viewport: Viewport): readonly HeaderSegment[] {
  const glyphs = getGlyphs();
  const separator = ` ${glyphs.bullet} `;
  const groups = headerGroups(model, glyphs);
  const mark = groups[0];
  if (mark === undefined) return [];

  let facts = groups.slice(1);
  const markWidth = segmentsWidth(mark.segments);
  const factsWidth = (list: readonly HeaderGroup[]): number =>
    list.length === 0
      ? 0
      : list.reduce((total, group) => total + segmentsWidth(group.segments), 0) +
        cells(separator) * (list.length - 1);

  while (facts.length > 0 && markWidth + 1 + factsWidth(facts) > viewport.width) {
    facts = facts.slice(1);
  }

  const right: HeaderSegment[] = [];
  facts.forEach((group, index) => {
    if (index > 0) right.push({ text: separator, fg: THEME.muted });
    right.push(...group.segments);
  });

  const left = truncateSegments(mark.segments, viewport.width);
  const gap = Math.max(0, viewport.width - segmentsWidth(left) - segmentsWidth(right));
  const padding: HeaderSegment[] = gap > 0 ? [{ text: " ".repeat(gap), fg: THEME.muted }] : [];
  return [...left, ...padding, ...right];
}

export function Header({ model, viewport }: { model: HeaderModel; viewport: Viewport }): ReactNode {
  const segments = headerSegments(model, viewport);
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

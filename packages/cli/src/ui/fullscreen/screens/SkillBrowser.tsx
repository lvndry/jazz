/** @jsxImportSource @opentui/react */

/**
 * Bounded `/skills` catalog and read-only detail screen. The bridge owns the
 * query, selection, and scroll offset so rendering remains a pure projection.
 * Search and detail use the same metadata as the Ink fallback.
 */

import type { SkillMetadata } from "@jazz/core/skills/skill-service";
import type { ReactNode } from "react";
import { windowStart } from "./AgentPicker";
import { getGlyphs } from "../../glyphs";
import { filterSkills, skillDetailRows, skillLine } from "../../skill-browser";
import { THEME } from "../../theme";
import { CaretValue } from "../overlays/TextPrompt";
import { clipTerminalCells } from "../terminal-cells";
import type { Viewport } from "../types";

const GUTTER = 2;
const RIGHT = 2;
const LIST_FRAME_ROWS = 5;
const DETAIL_FRAME_ROWS = 4;

export function skillListRows(viewport: Viewport): number {
  return Math.max(1, viewport.height - LIST_FRAME_ROWS - (viewport.width < 60 ? 1 : 0));
}

export function skillDetailBodyRows(viewport: Viewport): number {
  return Math.max(1, viewport.height - DETAIL_FRAME_ROWS);
}

export interface SkillBrowserProps {
  readonly skills: readonly SkillMetadata[];
  readonly query: string;
  readonly caret: number;
  readonly selected: number;
  readonly detail: SkillMetadata | null;
  readonly detailOffset: number;
  readonly viewport: Viewport;
}

/** Paints the search list, or the selected skill's full metadata. */
export function SkillBrowser({
  skills,
  query,
  caret,
  selected,
  detail,
  detailOffset,
  viewport,
}: SkillBrowserProps): ReactNode {
  const glyphs = getGlyphs();
  const content = Math.max(1, viewport.width - GUTTER - RIGHT);
  const filtered = filterSkills(skills, query);
  const active = Math.max(0, Math.min(selected, filtered.length - 1));

  if (detail !== null) {
    const rows = skillDetailRows(detail, viewport.width);
    const bodyHeight = skillDetailBodyRows(viewport);
    const start = Math.max(0, Math.min(detailOffset, Math.max(0, rows.length - bodyHeight)));
    return (
      <box
        style={{
          width: viewport.width,
          height: viewport.height,
          flexDirection: "column",
          backgroundColor: THEME.canvas,
        }}
      >
        <box style={{ height: 1, flexShrink: 0 }} />
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ width: GUTTER, flexShrink: 0, fg: THEME.primary }}>{glyphs.note}</text>
          <text style={{ fg: THEME.selected, wrapMode: "none", truncate: true }}>
            <b>{clipTerminalCells(`skill: ${skillLine(detail.name)}`, content)}</b>
          </text>
        </box>
        <box style={{ height: 1, flexShrink: 0 }} />
        <box style={{ height: bodyHeight, flexShrink: 0, flexDirection: "column" }}>
          {rows.slice(start, start + bodyHeight).map((row, index) => (
            <box
              key={start + index}
              style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
            >
              <box style={{ width: GUTTER, flexShrink: 0 }} />
              <text
                style={{
                  fg: row.heading ? THEME.primary : THEME.secondary,
                  wrapMode: "none",
                  truncate: true,
                }}
              >
                {row.heading ? <b>{row.text}</b> : row.text || " "}
              </text>
            </box>
          ))}
        </box>
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <box style={{ width: GUTTER, flexShrink: 0 }} />
          <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
            {clipTerminalCells(
              `up down scroll   esc back${rows.length > bodyHeight ? `   ${start + 1}-${Math.min(start + bodyHeight, rows.length)} of ${rows.length}` : ""}`,
              content,
            )}
          </text>
        </box>
      </box>
    );
  }

  const listHeight = skillListRows(viewport);
  const start = windowStart(filtered.length, active, listHeight);
  const sourceWidth = Math.min(9, Math.max(6, Math.floor(content / 4)));
  const nameWidth = Math.max(1, content - sourceWidth - 2);
  const position = filtered.length === 0 ? "no matches" : `${active + 1} of ${filtered.length}`;

  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: THEME.canvas,
      }}
    >
      <box style={{ height: 1, flexShrink: 0 }} />
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text style={{ width: GUTTER, flexShrink: 0, fg: THEME.primary }}>{glyphs.note}</text>
        <text style={{ fg: THEME.selected, wrapMode: "none", truncate: true }}>
          <b>skills</b>
        </text>
        <box style={{ flexGrow: 1 }} />
        <text style={{ fg: THEME.muted, flexShrink: 0 }}>{position}</text>
        <box style={{ width: RIGHT, flexShrink: 0 }} />
      </box>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text style={{ width: GUTTER, flexShrink: 0, fg: THEME.primary }}>
          {glyphs.promptCursor}
        </text>
        {query === "" ? (
          <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
            type to filter by name, source, or description
          </text>
        ) : (
          <CaretValue
            value={query}
            caret={caret}
            width={content}
          />
        )}
      </box>
      <box style={{ height: 1, flexShrink: 0 }} />
      <box style={{ height: listHeight, flexShrink: 0, flexDirection: "column" }}>
        {filtered.length === 0 ? (
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <box style={{ width: GUTTER, flexShrink: 0 }} />
            <text style={{ fg: THEME.secondary, wrapMode: "none", truncate: true }}>
              {skills.length === 0
                ? "No skills found. Add a SKILL.md under ./skills/."
                : "No matching skills."}
            </text>
          </box>
        ) : (
          filtered.slice(start, start + listHeight).map((skill, offset) => {
            const isSelected = start + offset === active;
            return (
              <box
                key={`${skill.source}:${skill.name}`}
                style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
              >
                <text style={{ width: GUTTER, flexShrink: 0, fg: THEME.primary }}>
                  {isSelected ? glyphs.rail : " "}
                </text>
                <text style={{ width: nameWidth, flexShrink: 0, wrapMode: "none", truncate: true }}>
                  {isSelected ? (
                    <b style={{ fg: THEME.selected }}>
                      {clipTerminalCells(skillLine(skill.name), nameWidth)}
                    </b>
                  ) : (
                    <span style={{ fg: THEME.secondary }}>
                      {clipTerminalCells(skillLine(skill.name), nameWidth)}
                    </span>
                  )}
                </text>
                <box style={{ width: 2, flexShrink: 0 }} />
                <text
                  style={{ width: sourceWidth, fg: THEME.muted, wrapMode: "none", truncate: true }}
                >
                  {skill.source}
                </text>
              </box>
            );
          })
        )}
      </box>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <box style={{ width: GUTTER, flexShrink: 0 }} />
        <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
          {clipTerminalCells(
            viewport.width < 60
              ? "type search   up down move"
              : "type search   up down move   enter details   esc close",
            content,
          )}
        </text>
      </box>
      {viewport.width < 60 ? (
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <box style={{ width: GUTTER, flexShrink: 0 }} />
          <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
            enter details esc close
          </text>
        </box>
      ) : null}
    </box>
  );
}

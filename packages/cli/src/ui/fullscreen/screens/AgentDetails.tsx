/** @jsxImportSource @opentui/react */

/**
 * Scrollable read-only agent inspector. Rows are wrapped by terminal cell width so
 * long descriptions, tool lists, and host paths remain inspectable on narrow terminals.
 * The bridge owns the scroll offset and keyboard routing; this screen only paints data.
 */

import type { ReactNode } from "react";
import type { ActiveAgentDetails } from "../../store";
import { THEME } from "../../theme";
import { clipTerminalCells, terminalCellWidth, wrapTerminalCells } from "../terminal-cells";
import type { Viewport } from "../types";

const GUTTER = 2;
const RIGHT_MARGIN = 2;
const LABEL_WIDTH = 17;
const FRAME_ROWS = 5;

/** Physical body rows after wrapping all fields at the current viewport width. */
export function agentDetailsRows(
  fields: ActiveAgentDetails["fields"],
  width: number,
): readonly { readonly text: string; readonly section: boolean }[] {
  const content = Math.max(1, width - GUTTER - RIGHT_MARGIN);
  const labelWidth = Math.min(LABEL_WIDTH, Math.max(8, Math.floor(content / 3)));
  const valueWidth = Math.max(1, content - labelWidth - 2);
  const rows: { text: string; section: boolean }[] = [];
  let currentSection = "";
  for (const field of fields) {
    if (field.section !== currentSection) {
      if (rows.length > 0) rows.push({ text: "", section: false });
      rows.push({ text: field.section, section: true });
      currentSection = field.section;
    }
    const clippedLabel = clipTerminalCells(field.label, labelWidth);
    const label = clippedLabel + " ".repeat(labelWidth - terminalCellWidth(clippedLabel));
    for (const [index, part] of wrapTerminalCells(
      field.value.replace(/[\r\n\t]/g, " "),
      valueWidth,
    ).entries()) {
      rows.push({
        text: `${index === 0 ? label : " ".repeat(labelWidth)}  ${part}`,
        section: false,
      });
    }
  }
  return rows;
}

/** Number of rows the body may show without covering the title or key legend. */
export function agentDetailsBodyHeight(viewport: Viewport): number {
  return Math.max(1, viewport.height - FRAME_ROWS);
}

export function AgentDetails({
  name,
  fields,
  offset,
  viewport,
}: ActiveAgentDetails & { readonly offset: number; readonly viewport: Viewport }): ReactNode {
  const rows = agentDetailsRows(fields, viewport.width);
  const bodyHeight = agentDetailsBodyHeight(viewport);
  const maxOffset = Math.max(0, rows.length - bodyHeight);
  const start = Math.max(0, Math.min(offset, maxOffset));
  const visible = rows.slice(start, start + bodyHeight);
  const contentWidth = Math.max(1, viewport.width - GUTTER - RIGHT_MARGIN);

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
        <box style={{ width: GUTTER, flexShrink: 0 }} />
        <text style={{ fg: THEME.selected, wrapMode: "none", truncate: true }}>
          <b>{clipTerminalCells(`agent: ${name}`, contentWidth)}</b>
        </text>
      </box>
      <box style={{ height: 1, flexShrink: 0 }} />
      <box style={{ height: bodyHeight, flexShrink: 0, flexDirection: "column" }}>
        {visible.map((row, index) => (
          <box
            key={start + index}
            style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
          >
            <box style={{ width: GUTTER, flexShrink: 0 }} />
            <text
              style={{
                fg: row.section ? THEME.primary : THEME.secondary,
                wrapMode: "none",
                truncate: true,
              }}
            >
              {row.section ? <b>{row.text}</b> : row.text}
            </text>
          </box>
        ))}
      </box>
      <box style={{ height: 1, flexShrink: 0 }} />
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <box style={{ width: GUTTER, flexShrink: 0 }} />
        <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
          {`up down scroll   esc back${rows.length > bodyHeight ? `   ${start + 1}-${Math.min(start + bodyHeight, rows.length)} of ${rows.length}` : ""}`}
        </text>
      </box>
    </box>
  );
}

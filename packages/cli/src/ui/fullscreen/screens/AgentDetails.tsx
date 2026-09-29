/** @jsxImportSource @opentui/react */

/**
 * Scrollable read-only agent inspector. Rows are wrapped by terminal cell width so
 * long descriptions, tool lists, and host paths remain inspectable on narrow terminals.
 * The bridge owns the scroll offset and keyboard routing; this screen only paints data.
 */

import type { ReactNode } from "react";
import {
  agentDetailsBodyHeight,
  agentDetailsRows,
  AGENT_DETAILS_GUTTER,
  AGENT_DETAILS_RIGHT_MARGIN,
} from "../../models/agent-details";
import type { ActiveAgentDetails } from "../../store";
import { clipTerminalCells } from "../../text/terminal-cells";
import { groundPaint, THEME } from "../../theme";
import type { Viewport } from "../types";

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
  const contentWidth = Math.max(
    1,
    viewport.width - AGENT_DETAILS_GUTTER - AGENT_DETAILS_RIGHT_MARGIN,
  );

  return (
    <box
      style={{
        width: viewport.width,
        height: viewport.height,
        flexDirection: "column",
        backgroundColor: groundPaint(),
      }}
    >
      <box style={{ height: 1, flexShrink: 0 }} />
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <box style={{ width: AGENT_DETAILS_GUTTER, flexShrink: 0 }} />
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
            <box style={{ width: AGENT_DETAILS_GUTTER, flexShrink: 0 }} />
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
        <box style={{ width: AGENT_DETAILS_GUTTER, flexShrink: 0 }} />
        <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
          {`up down scroll   esc back${rows.length > bodyHeight ? `   ${start + 1}-${Math.min(start + bodyHeight, rows.length)} of ${rows.length}` : ""}`}
        </text>
      </box>
    </box>
  );
}

/**
 * Layout of the agent details screen, shared by the fullscreen and Ink renderers: which
 * rows the fields wrap to at a width, and how many of them fit under the frame.
 */

import type { ActiveAgentDetails } from "../store";
import { clipTerminalCells, terminalCellWidth, wrapTerminalCells } from "../text/terminal-cells";

/** A viewport, in terminal cells. */
export interface DetailsViewport {
  readonly width: number;
  readonly height: number;
}

export const AGENT_DETAILS_GUTTER = 2;
export const AGENT_DETAILS_RIGHT_MARGIN = 2;
const LABEL_WIDTH = 17;
const FRAME_ROWS = 5;

/** Physical body rows after wrapping all fields at the current viewport width. */
export function agentDetailsRows(
  fields: ActiveAgentDetails["fields"],
  width: number,
): readonly { readonly text: string; readonly section: boolean }[] {
  const content = Math.max(1, width - AGENT_DETAILS_GUTTER - AGENT_DETAILS_RIGHT_MARGIN);
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
export function agentDetailsBodyHeight(viewport: DetailsViewport): number {
  return Math.max(1, viewport.height - FRAME_ROWS);
}

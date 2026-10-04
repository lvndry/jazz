/**
 * The Ink rendering of the command panel: a bordered box centered under the chat, above the
 * prompt. Ink has no layers, so the panel sits in the flow instead of floating; the agent's
 * output keeps arriving above it. Esc closes it and up/down scroll a long one.
 */

import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { InputPriority, InputResults } from "@/cli/services/input-service";
import { COMMAND_PANEL_HINT, commandPanelRows, type CommandPanel } from "./command-panel";
import { useTerminalDimensions } from "./contexts/TerminalDimensionsContext";
import { getGlyphs } from "./glyphs";
import { useInputHandler } from "./hooks/use-input-service";
import { store } from "./store";
import { paintRole } from "./text/roles";
import { THEME } from "./theme";

/** The border and one column of padding on each side. */
const CHROME_COLUMNS = 4;
/** The border, the title row and the blank row under it. */
const CHROME_ROWS = 4;
/** Rows left for the chat and the prompt around the panel. */
const SCREEN_MARGIN_ROWS = 10;
const MAX_WIDTH = 96;
const MIN_BODY_ROWS = 3;

export function CommandPanelView({ panel }: { readonly panel: CommandPanel }): React.ReactElement {
  const { cols: columns, rows: terminalRows } = useTerminalDimensions();
  const width = Math.max(CHROME_COLUMNS + 10, Math.min(MAX_WIDTH, columns - 2));
  const rows = commandPanelRows(panel, getGlyphs(), width - CHROME_COLUMNS);
  const bodyRows = Math.max(MIN_BODY_ROWS, terminalRows - SCREEN_MARGIN_ROWS - CHROME_ROWS);
  const maxOffset = Math.max(0, rows.length - bodyRows);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [panel.id]);

  // The input service holds a lone Esc back in case a sequence follows, so Esc is read raw,
  // the way the other Ink modals read it.
  useInput((_input, key) => {
    if (key.escape) {
      store.closeCommandPanel();
    }
  });

  useInputHandler({
    id: "command-panel",
    priority: InputPriority.MODAL,
    onInput: (action) => {
      if (action.type === "up") {
        setOffset((current) => Math.max(0, current - 1));
      } else if (action.type === "down") {
        setOffset((current) => Math.min(maxOffset, current + 1));
      }
      return InputResults.consumed();
    },
    deps: [maxOffset],
  });

  const shown = rows.slice(Math.min(offset, maxOffset), Math.min(offset, maxOffset) + bodyRows);
  const hint = maxOffset > 0 ? `up down to scroll  ${COMMAND_PANEL_HINT}` : COMMAND_PANEL_HINT;
  return (
    <Box
      width="100%"
      justifyContent="center"
    >
      <Box
        width={width}
        flexDirection="column"
        borderStyle="round"
        borderColor={THEME.border}
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text
            bold
            color={THEME.selected}
          >
            {panel.command}
          </Text>
          <Text color={THEME.muted}>{hint}</Text>
        </Box>
        <Text> </Text>
        {shown.map((row, rowIndex) => (
          <Text key={`${String(panel.id)}:${String(offset + rowIndex)}`}>
            {row.length === 0
              ? " "
              : row.map((segment) => paintRole(segment.role, segment.text)).join("")}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

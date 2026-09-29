/**
 * Renders a single scrollback `OutputEntryWithId` (success/error/warn/info/
 * log/user/streamContent) with the icon and color for its type.
 */

import { Box, Text } from "ink";
import React from "react";
import { PreWrappedText } from "./components/PreWrappedText";
import { getGlyphs } from "./glyphs";
import {
  receiptDiffRows,
  receiptFromMeta,
  receiptMark,
  receiptParts,
  type ToolReceipt,
} from "./models/receipt";
import { RAIL_WIDTH, railStreamLines } from "./rail";
import { paintRole, paintSegments } from "./text/roles";
import { PADDING, PADDING_BUDGET, THEME } from "./theme";
import type { OutputEntryWithId, OutputType } from "./types";
import { dimReasoningMarkdownOutput, spaceReasoningSections } from "../presentation/format-utils";
import { getTerminalWidth } from "../utils/string-utils";
import { markdownToAnsi } from "./markdown/ansi";

// Icons and colours are read per render, so a `/theme` switch or the ASCII glyph set reaches
// entries already in the scrollback.
function iconFor(type: OutputType): React.ReactElement {
  const glyphs = getGlyphs();
  switch (type) {
    case "success":
      return <Text color={THEME.success}>{glyphs.success}</Text>;
    case "error":
      return <Text color={THEME.error}>{glyphs.error}</Text>;
    case "warn":
      return <Text color={THEME.warning}>{glyphs.warn}</Text>;
    case "info":
      return <Text color={THEME.info}>{glyphs.info}</Text>;
    case "debug":
      return <Text color={THEME.secondary}>{glyphs.debug}</Text>;
    case "user":
      return <Text color={THEME.primary}>{glyphs.arrow}</Text>;
    case "log":
    case "streamContent":
      return <></>;
  }
}

function colorFor(type: OutputType): string {
  switch (type) {
    case "success":
      return THEME.success;
    case "error":
      return THEME.error;
    case "warn":
      return THEME.warning;
    case "debug":
      return THEME.secondary;
    case "user":
      return THEME.primary;
    case "info":
      return THEME.info;
    case "log":
    case "streamContent":
      return THEME.selected;
  }
}

/**
 * A settled tool call, laid out from the same receipt parts the fullscreen transcript uses: the
 * status mark, then app, arguments, outcome, and on a denial or failure what did not happen.
 * Receipts sit tight against each other so a burst of calls reads as one group.
 */
function ReceiptLine({ receipt }: { receipt: ToolReceipt }): React.ReactElement {
  const glyphs = getGlyphs();
  const mark = receiptMark(receipt, glyphs);
  const diffRows = receiptDiffRows(receipt);
  return (
    <Box
      paddingLeft={PADDING.content}
      flexDirection="column"
    >
      <Text wrap="wrap">
        {paintRole(mark.role, mark.text)}{" "}
        {paintSegments(receiptParts(receipt, glyphs, { duration: true }))}
      </Text>
      {diffRows.map((row, index) => (
        <Text
          key={index}
          wrap="truncate-end"
        >
          {"  "}
          {paintRole(row.role, row.text)}
        </Text>
      ))}
    </Box>
  );
}

/**
 * Individual output entry component - memoized to prevent re-renders
 * when other entries are added to the list.
 *
 * IMPORTANT: Props must be stable for memoization to work effectively.
 * - `entry` object reference should be stable (not recreated)
 * - `addSpacing` is a primitive boolean (pre-computed in parent)
 *
 * Without React.memo, every entry would re-render whenever ANY entry
 * is added to the list, causing significant performance degradation
 * during streaming responses.
 */
export const OutputEntryView = React.memo(function OutputEntryView({
  entry,
  addSpacing,
}: {
  entry: OutputEntryWithId;
  addSpacing: boolean;
}): React.ReactElement {
  const receipt = receiptFromMeta(entry.meta?.["toolReceipt"]);
  if (receipt !== null) {
    return <ReceiptLine receipt={receipt} />;
  }

  const icon = iconFor(entry.type);
  const color = colorFor(entry.type);

  if (entry.type === "streamContent") {
    // streamContent slices are stored RAW by the scrollback buffer (so the
    // markdown-aware split-point finder can operate on raw text). Format at
    // render time. For reasoning slices, post-process with the dim styling so
    // settled reasoning matches the live pending render.
    const kind = entry.meta?.["kind"];
    const raw =
      kind === "reasoning"
        ? spaceReasoningSections(entry.message as string)
        : (entry.message as string);
    // Pre-wrap, same as the pending tail in App.tsx: a bare <Text wrap="wrap">
    // lets Yoga re-wrap settled slices, which degenerates into char-by-char
    // wrapping under live re-render load. Each line carries the speaker rail
    // (cyan = agent, indigo = reasoning) — the transcript's color-coded left edge.
    const width = Math.max(20, getTerminalWidth() - PADDING_BUDGET - PADDING.content - RAIL_WIDTH);
    const formatted = markdownToAnsi(raw, { width, syntax: "rendered" });
    const display = kind === "reasoning" ? dimReasoningMarkdownOutput(formatted) : formatted;
    return (
      <Box
        marginTop={addSpacing ? 1 : 0}
        marginBottom={0}
        paddingLeft={PADDING.content}
      >
        <PreWrappedText>{railStreamLines(display, kind)}</PreWrappedText>
      </Box>
    );
  }

  if (typeof entry.message === "string") {
    if (entry.type === "user") {
      // Speaker rail: a brass bar down the left of everything you said.
      // The agent's reply gets a cyan rail — color IS the speaker label.
      const userLines = entry.message.split("\n");
      return (
        <Box
          flexDirection="column"
          marginTop={addSpacing ? 1 : 0}
          marginBottom={1}
          paddingLeft={PADDING.content}
        >
          {userLines.map((line, index) => (
            <Box key={index}>
              <Text
                color={THEME.primary}
                bold
              >
                {getGlyphs().rail}{" "}
              </Text>
              <PreWrappedText color={THEME.selected}>{line}</PreWrappedText>
            </Box>
          ))}
        </Box>
      );
    }

    // Log entries: render just the text with no icon/space siblings.
    // No pre-wrapping — the terminal handles line wrapping natively.
    if (entry.type === "log") {
      // A blank log line is a spacer — render exactly one row. With the
      // default marginBottom it occupied two, and command output that emits
      // fmt.blank() twice ballooned to ~4 empty rows.
      if (entry.message === "") {
        return (
          <Box
            marginTop={0}
            marginBottom={0}
          >
            <Text> </Text>
          </Box>
        );
      }
      return (
        <Box
          marginTop={addSpacing ? 1 : 0}
          marginBottom={1}
          paddingLeft={PADDING.content}
        >
          <Text>{entry.message}</Text>
        </Box>
      );
    }

    const isDebug = entry.type === "debug";
    // Debug entries (token/cost metric lines) come in stacked groups with no
    // visual separation between them; we collapse marginBottom so consecutive
    // debug lines are tight, then rely on the next non-debug entry's
    // marginTop (or its own internal separator) to break out of the group.
    return (
      <Box
        marginTop={addSpacing ? 1 : 0}
        marginBottom={isDebug ? 0 : 1}
        paddingLeft={PADDING.content}
      >
        {icon}
        <Text> </Text>
        <Text
          color={color}
          wrap="wrap"
        >
          {entry.message}
        </Text>
      </Box>
    );
  }

  if (entry.message._tag === "ink" && React.isValidElement(entry.message.node)) {
    return (
      <Box
        marginTop={addSpacing ? 1 : 0}
        marginBottom={1}
        paddingLeft={PADDING.content}
      >
        {entry.message.node}
      </Box>
    );
  }

  return (
    <Box
      marginTop={0}
      marginBottom={0}
    >
      {iconFor("warn")}
      <Text> </Text>
      <Text color={THEME.warning}>[Unsupported UI output]</Text>
    </Box>
  );
});

import { Box, Text } from "ink";
import React from "react";
import { getGlyphs } from "./glyphs";
import { PADDING, THEME } from "./theme";
import type { OutputEntryWithId, OutputType } from "./types";
import { dimReasoningMarkdownOutput } from "../presentation/format-utils";
import { formatMarkdown } from "../presentation/markdown-formatter";

// Icons routed through the glyph module so they degrade to ASCII when the
// user's font/terminal don't render Unicode dingbats reliably. Computed
// once per process — `getGlyphs()` reads env at module init; tests that
// flip the env mid-process should restart the module if they need a
// different set, but that's intentional (we don't want a per-render env
// read).
const G = getGlyphs();
const ICONS: Record<OutputType, React.ReactElement> = {
  success: <Text color={THEME.success}>{G.success}</Text>,
  error: <Text color={THEME.error}>{G.error}</Text>,
  warn: <Text color={THEME.warning}>{G.warn}</Text>,
  info: <Text color={THEME.info}>{G.info}</Text>,
  debug: <Text color={THEME.secondary}>{G.debug}</Text>,
  user: <Text color={THEME.primary}>{G.arrow}</Text>,
  log: <></>,
  streamContent: <></>,
};

const COLORS: Record<OutputType, string> = {
  success: THEME.success,
  error: THEME.error,
  warn: THEME.warning,
  debug: THEME.secondary,
  user: THEME.primary,
  info: THEME.info,
  log: "white",
  streamContent: "white",
};

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
  const icon = ICONS[entry.type];
  const color = COLORS[entry.type];

  if (entry.type === "streamContent") {
    // streamContent slices are stored RAW by the scrollback buffer (so the
    // markdown-aware split-point finder can operate on raw text). Format at
    // render time. For reasoning slices, post-process with the dim styling so
    // settled reasoning matches the live pending render.
    const raw = entry.message as string;
    const formatted = formatMarkdown(raw);
    const kind = entry.meta?.["kind"];
    const display = kind === "reasoning" ? dimReasoningMarkdownOutput(formatted) : formatted;
    return (
      <Box
        marginTop={0}
        marginBottom={0}
        paddingLeft={PADDING.content}
      >
        <Text>{display}</Text>
      </Box>
    );
  }

  if (typeof entry.message === "string") {
    if (entry.type === "user") {
      return (
        <Box
          marginTop={addSpacing ? 1 : 0}
          marginBottom={1}
          paddingLeft={PADDING.content}
        >
          <Text color={THEME.primary}>You:</Text>
          <Text> </Text>
          <Text
            color="white"
            wrap="wrap"
          >
            {entry.message}
          </Text>
        </Box>
      );
    }

    // Log entries: render just the text with no icon/space siblings.
    // No pre-wrapping — the terminal handles line wrapping natively.
    if (entry.type === "log") {
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
      {ICONS.warn}
      <Text> </Text>
      <Text color="yellow">[Unsupported UI output]</Text>
    </Box>
  );
});

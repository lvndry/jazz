/** @jsxImportSource @opentui/react */

/**
 * The search overlay.
 *
 * Fullscreen means jazz owns history now, so history has to be reachable from
 * inside the app rather than by grepping a log directory. A query, a scope
 * pill, incrementally matched hits, a count, and the keys.
 *
 * Two rules shape the rendering. A match is marked with an attribute —
 * underline — and never by colour alone, because the 256-colour floor cannot
 * be trusted to separate two tints. And the frame never resizes: the list
 * region keeps its height whether there are forty hits or none, so typing a
 * query that matches nothing does not move anything the reader is looking at.
 */

import type { BorderCharacters, ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, type ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { THEME } from "../../theme";
import {
  clipTerminalCells,
  clipTerminalCellsFromStart,
  sliceTerminalCells,
  terminalCellWidth,
  terminalGraphemes,
} from "../terminal-cells";
import type { SearchHit, SearchOverlay, Viewport } from "../types";

const MAX_WIDTH = 76;
const MIN_WINDOWED_HEIGHT = 20;

/** Windowed height, fixed: the overlay does not grow with the result count. */
const WINDOWED_HEIGHT = 19;

const CARD_PAD = 1;

/** Border, query, rule, rule, count, border. */
const FIXED_CARD_ROWS = 6;

const HINT_ROWS = 1;

/** A hit is a title row and the matched line beneath it. */
const HIT_ROWS = 2;

/** The matched line is indented under its title. */
const LINE_INDENT = 3;

/** Keep this much of the line to the left of the match when it has to scroll. */
const MATCH_LEAD = 12;

function displayWidth(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function frameChars(glyphs: GlyphSet): BorderCharacters {
  return {
    topLeft: glyphs.boxTL,
    topRight: glyphs.boxTR,
    bottomLeft: glyphs.boxBL,
    bottomRight: glyphs.boxBR,
    horizontal: glyphs.boxH,
    vertical: glyphs.boxV,
    topT: glyphs.boxTJ,
    bottomT: glyphs.boxBJ,
    leftT: glyphs.boxML,
    rightT: glyphs.boxMR,
    cross: glyphs.boxMJ,
  };
}

interface MarkedLine {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/**
 * Slide a window over the matched line so the match itself is always visible,
 * even when it sits three hundred characters into a wrapped paragraph.
 */
function markLine(hit: SearchHit, width: number): MarkedLine {
  const text = oneLine(hit.line);
  const graphemes = terminalGraphemes(text);
  const codePointLength = [...text].length;
  const start = Math.max(0, Math.min(hit.matchStart, codePointLength));
  const end = Math.max(start, Math.min(start + hit.matchLength, codePointLength));
  let codePointOffset = 0;
  let matchStart = 0;
  while (
    matchStart < graphemes.length &&
    codePointOffset + [...(graphemes[matchStart] as string)].length <= start
  ) {
    codePointOffset += [...(graphemes[matchStart] as string)].length;
    matchStart += 1;
  }
  let matchEnd = matchStart;
  while (matchEnd < graphemes.length && codePointOffset < end) {
    codePointOffset += [...(graphemes[matchEnd] as string)].length;
    matchEnd += 1;
  }
  const prefix = graphemes.slice(0, matchStart).join("");
  const matched = graphemes.slice(matchStart, matchEnd).join("");
  const suffix = graphemes.slice(matchEnd).join("");
  const visibleMatch = sliceTerminalCells(matched, width);
  const remaining = Math.max(0, width - terminalCellWidth(visibleMatch));
  const before = clipTerminalCellsFromStart(prefix, Math.min(MATCH_LEAD, remaining));
  const after = sliceTerminalCells(suffix, Math.max(0, remaining - terminalCellWidth(before)));

  return {
    before,
    match: visibleMatch,
    after,
  };
}

function countLabel(total: number): string {
  if (total === 0) return "no matches";
  if (total === 1) return "1 match";
  return `${String(total)} matches`;
}

export interface SearchProps {
  readonly model: SearchOverlay;
  readonly viewport: Viewport;
}

export function Search({ model, viewport }: SearchProps): ReactNode {
  const glyphs = getGlyphs();

  const fullscreen = viewport.width < MAX_WIDTH || viewport.height < MIN_WINDOWED_HEIGHT;
  const width = fullscreen ? viewport.width : Math.min(MAX_WIDTH, viewport.width - 4);
  const inner = Math.max(8, width - 2 - CARD_PAD * 2);

  const height = fullscreen
    ? viewport.height
    : Math.min(WINDOWED_HEIGHT, viewport.height - HINT_ROWS);
  const cardHeight = Math.max(1, height - HINT_ROWS);
  const listRows = Math.max(HIT_ROWS, cardHeight - FIXED_CARD_ROWS);

  const left = fullscreen ? 0 : Math.max(0, Math.floor((viewport.width - width) / 2));
  const top = fullscreen ? 0 : Math.max(0, Math.floor((viewport.height - height) / 2));

  const scopeLabel = model.scope === "conversation" ? "this conversation" : "all conversations";
  const pillWidth = displayWidth(scopeLabel) + 4;
  const queryWidth = Math.max(4, inner - pillWidth - 3);
  const lineWidth = Math.max(4, inner - LINE_INDENT);
  const selected = Math.max(0, Math.min(model.selected, model.hits.length - 1));

  const list = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const box = list.current;
    if (box === null) return;
    const target = selected * HIT_ROWS;
    if (target < box.scrollTop) box.scrollTop = target;
    else if (target + HIT_ROWS > box.scrollTop + listRows) {
      box.scrollTop = target + HIT_ROWS - listRows;
    }
  }, [selected, listRows]);

  return (
    <box
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        flexDirection: "column",
      }}
    >
      <box
        style={{
          height: cardHeight,
          flexShrink: 0,
          flexDirection: "column",
          backgroundColor: THEME.surface,
          border: true,
          customBorderChars: frameChars(glyphs),
          borderColor: THEME.border,
          paddingLeft: CARD_PAD,
          paddingRight: CARD_PAD,
        }}
      >
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.primary, flexShrink: 0 }}>{`${glyphs.promptCursor} `}</text>
          <text style={{ fg: THEME.selected }}>{clip(oneLine(model.query), queryWidth)}</text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ flexShrink: 0 }}>
            <span style={{ fg: THEME.muted }}>{"[ "}</span>
            <span style={{ fg: THEME.primary }}>{scopeLabel}</span>
            <span style={{ fg: THEME.muted }}>{" ]"}</span>
          </text>
        </box>

        <text style={{ fg: THEME.border, height: 1, flexShrink: 0 }}>
          {glyphs.divider.repeat(inner)}
        </text>

        {model.hits.length === 0 ? (
          <box style={{ height: listRows, flexShrink: 0, flexDirection: "column" }}>
            <text style={{ fg: THEME.secondary, height: 1, flexShrink: 0 }}>
              {clip(`No matches for "${oneLine(model.query)}" in ${scopeLabel}.`, inner)}
            </text>
          </box>
        ) : (
          <scrollbox
            style={{ height: listRows, flexShrink: 0 }}
            scrollbarOptions={{ visible: model.hits.length * HIT_ROWS > listRows }}
            ref={(instance: ScrollBoxRenderable | null) => {
              list.current = instance;
            }}
          >
            {model.hits.map((hit, index) => {
              const isSelected = index === selected;
              const marked = markLine(hit, lineWidth);
              // Selection is the title's weight and colour; which session the
              // hit came from is the marker beside it. One channel each.
              const titleColor = isSelected ? THEME.selected : THEME.secondary;
              return (
                <box
                  key={`${hit.conversationId}-${String(index)}`}
                  style={{ height: HIT_ROWS, flexShrink: 0, flexDirection: "column" }}
                >
                  <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
                    <text style={{ fg: THEME.primary, flexShrink: 0 }}>
                      {isSelected ? glyphs.rail : " "}
                    </text>
                    <text style={{ fg: hit.current ? THEME.primary : THEME.muted, flexShrink: 0 }}>
                      {`${hit.current ? glyphs.active : glyphs.pending} `}
                    </text>
                    <text style={{ flexGrow: 1 }}>
                      {isSelected ? (
                        <b style={{ fg: titleColor }}>
                          {clip(oneLine(hit.conversationTitle), inner - LINE_INDENT - 12)}
                        </b>
                      ) : (
                        <span style={{ fg: titleColor }}>
                          {clip(oneLine(hit.conversationTitle), inner - LINE_INDENT - 12)}
                        </span>
                      )}
                    </text>
                    <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(hit.when, 11)}</text>
                  </box>
                  <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
                    <text style={{ width: LINE_INDENT, flexShrink: 0 }}> </text>
                    <text style={{ fg: THEME.secondary }}>
                      <span style={{ fg: THEME.secondary }}>{marked.before}</span>
                      <u style={{ fg: THEME.selected }}>{marked.match}</u>
                      <span style={{ fg: THEME.secondary }}>{marked.after}</span>
                    </text>
                  </box>
                </box>
              );
            })}
          </scrollbox>
        )}

        <text style={{ fg: THEME.border, height: 1, flexShrink: 0 }}>
          {glyphs.divider.repeat(inner)}
        </text>

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>{countLabel(model.hits.length)}</text>
          <box style={{ flexGrow: 1 }} />
          {model.hits.length > 0 ? (
            <text style={{ fg: THEME.muted, flexShrink: 0 }}>
              {`${String(selected + 1)} of ${String(model.hits.length)}`}
            </text>
          ) : null}
        </box>
      </box>

      <box
        style={{
          height: HINT_ROWS,
          flexShrink: 0,
          flexDirection: "row",
          paddingLeft: CARD_PAD + 1,
          paddingRight: CARD_PAD + 1,
        }}
      >
        <text>
          <b style={{ fg: THEME.selected }}>enter</b>
          <span style={{ fg: THEME.secondary }}>{" insert"}</span>
          <span style={{ fg: THEME.muted }}>{"    "}</span>
          <b style={{ fg: THEME.selected }}>tab</b>
          <span style={{ fg: THEME.secondary }}>{" scope"}</span>
          <span style={{ fg: THEME.muted }}>{"    "}</span>
          <b style={{ fg: THEME.selected }}>esc</b>
          <span style={{ fg: THEME.secondary }}>{" close"}</span>
        </text>
      </box>
    </box>
  );
}

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

import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, type ReactNode } from "react";
import { OVERLAY_Z_INDEX } from "./centered";
import { BAND_CHROME_COLUMNS, bandStyle, overlayWidth, placeOverlay } from "./overlay-frame";
import { CaretValue } from "./TextPrompt";
import { getGlyphs } from "../../glyphs";
import {
  clipTerminalCells,
  clipTerminalCellsFromStart,
  sliceTerminalCells,
  terminalCellWidth,
  terminalGraphemes,
} from "../../text/terminal-cells";
import { THEME } from "../../theme";
import type { SearchHit, SearchOverlay, Viewport } from "../types";

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

function countLabel(total: number, conversations: number): string {
  if (total === 0) return "no matches";
  const matches = total === 1 ? "1 match" : `${String(total)} matches`;
  return `${matches} in ${String(conversations)} ${conversations === 1 ? "conversation" : "conversations"}`;
}

/** One row of the result list: a conversation's heading, or one matched line beneath it. */
export type SearchResultRow =
  | { readonly kind: "conversation"; readonly hit: SearchHit; readonly selected: boolean }
  | { readonly kind: "line"; readonly hit: SearchHit; readonly index: number };

/**
 * Hits grouped under the conversation they came from, in rank order: a run of hits from
 * one conversation shares a heading, so the title and date are read once rather than per
 * line. Grouping never reorders; a conversation that ranks twice appears twice.
 */
export function searchResultRows(hits: readonly SearchHit[], selected: number): SearchResultRow[] {
  const rows: SearchResultRow[] = [];
  let groupStart = 0;
  hits.forEach((hit, index) => {
    if (index === 0 || hits[index - 1]?.conversationId !== hit.conversationId) {
      groupStart = index;
      let groupEnd = index;
      while (hits[groupEnd + 1]?.conversationId === hit.conversationId) groupEnd += 1;
      rows.push({
        kind: "conversation",
        hit,
        selected: selected >= groupStart && selected <= groupEnd,
      });
    }
    rows.push({ kind: "line", hit, index });
  });
  return rows;
}

function conversationCount(hits: readonly SearchHit[]): number {
  return new Set(hits.map((hit) => hit.conversationId)).size;
}

export interface SearchProps {
  readonly model: SearchOverlay;
  readonly viewport: Viewport;
}

/** The card's size and placement; `height` is what the layout reserves. */
export function searchLayout(viewport: Viewport) {
  const frame = overlayWidth(viewport);
  const placement = placeOverlay(viewport, frame, WINDOWED_HEIGHT);
  const cardHeight = Math.max(1, placement.height - HINT_ROWS);
  return {
    ...placement,
    inner: Math.max(8, frame.width - BAND_CHROME_COLUMNS),
    cardHeight,
    listRows: Math.max(HIT_ROWS, cardHeight - FIXED_CARD_ROWS),
  };
}

export function Search({ model, viewport }: SearchProps): ReactNode {
  const glyphs = getGlyphs();
  const { width, inner, height, cardHeight, listRows, left, top } = searchLayout(viewport);

  const scopeLabel = model.scope === "conversation" ? "this conversation" : "all conversations";
  const count = countLabel(model.hits.length, conversationCount(model.hits));
  const queryWidth = Math.max(4, inner - displayWidth(count) - 3);
  const lineWidth = Math.max(4, inner - LINE_INDENT);
  const selected = Math.max(0, Math.min(model.selected, model.hits.length - 1));
  const resultRows = searchResultRows(model.hits, selected);
  const selectedRow = resultRows.findIndex((row) => row.kind === "line" && row.index === selected);

  const list = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    const box = list.current;
    if (box === null) return;
    // Bring the conversation heading into view with its line when there is room.
    const target = Math.max(0, selectedRow - 1);
    if (target < box.scrollTop) box.scrollTop = target;
    else if (selectedRow + 1 > box.scrollTop + listRows) box.scrollTop = selectedRow + 1 - listRows;
  }, [selectedRow, listRows]);

  return (
    <box
      style={{
        position: "absolute",
        zIndex: OVERLAY_Z_INDEX,
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
          ...bandStyle(glyphs, THEME.surface, THEME.border),
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.primary, flexShrink: 0 }}>{`${glyphs.promptCursor} `}</text>
          <CaretValue
            value={oneLine(model.query)}
            caret={model.caret}
            width={queryWidth}
          />
          <box style={{ flexGrow: 1 }} />
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>{count}</text>
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />

        {model.hits.length === 0 ? (
          <box style={{ height: listRows, flexShrink: 0, flexDirection: "column" }}>
            <text style={{ fg: THEME.secondary, height: 1, flexShrink: 0 }}>
              {clip(`No matches for "${oneLine(model.query)}" in ${scopeLabel}.`, inner)}
            </text>
          </box>
        ) : (
          <scrollbox
            style={{ height: listRows, flexShrink: 0 }}
            scrollbarOptions={{ visible: resultRows.length > listRows }}
            ref={(instance: ScrollBoxRenderable | null) => {
              list.current = instance;
            }}
          >
            {resultRows.map((row, rowIndex) => {
              if (row.kind === "conversation") {
                const { hit } = row;
                // Selection is the title's weight; which session the hit came from is the
                // marker beside it. One channel each.
                const title = clip(oneLine(hit.conversationTitle), inner - LINE_INDENT - 12);
                return (
                  <box
                    key={`title-${String(rowIndex)}`}
                    style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
                  >
                    <text style={{ flexShrink: 0 }}> </text>
                    <text style={{ fg: hit.current ? THEME.primary : THEME.muted, flexShrink: 0 }}>
                      {`${hit.current ? glyphs.active : glyphs.pending} `}
                    </text>
                    <text style={{ flexGrow: 1 }}>
                      {row.selected ? (
                        <b style={{ fg: THEME.selected }}>{title}</b>
                      ) : (
                        <span style={{ fg: THEME.secondary }}>{title}</span>
                      )}
                    </text>
                    <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(hit.when, 11)}</text>
                  </box>
                );
              }
              const isSelected = row.index === selected;
              const marked = markLine(row.hit, lineWidth);
              const lineColor = isSelected ? THEME.secondary : THEME.muted;
              return (
                <box
                  key={`line-${String(rowIndex)}`}
                  style={{
                    height: 1,
                    flexShrink: 0,
                    flexDirection: "row",
                    // The selected line lifts to the element plane, like every list's selection.
                    ...(isSelected ? { backgroundColor: THEME.surfaceStrong } : {}),
                  }}
                >
                  <text style={{ fg: THEME.primary, flexShrink: 0 }}>
                    {isSelected ? glyphs.rail : " "}
                  </text>
                  <text style={{ width: LINE_INDENT - 1, flexShrink: 0 }}> </text>
                  <text>
                    <span style={{ fg: lineColor }}>{marked.before}</span>
                    <span
                      style={{
                        fg: THEME.selected,
                        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
                      }}
                    >
                      {marked.match}
                    </span>
                    <span style={{ fg: lineColor }}>{marked.after}</span>
                  </text>
                </box>
              );
            })}
          </scrollbox>
        )}

        <box style={{ height: 1, flexShrink: 0 }} />

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>{`searching ${scopeLabel}`}</text>
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

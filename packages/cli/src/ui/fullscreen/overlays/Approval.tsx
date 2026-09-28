/** @jsxImportSource @opentui/react */

/**
 * The approval overlay.
 *
 * A coding agent asks to edit a file you can revert. Jazz asks to send an
 * email, write to a calendar, or post where other people read it — and there
 * is no undo for any of those. So this object breaks the visual language in
 * exactly one deliberate way: it is elevated onto a `surface` panel behind a
 * frame, marked with the `proposed` glyph that appears nowhere else in the
 * product. Everything else about it is quiet on purpose.
 *
 *   - The real account is rendered verbatim, because the whole trust argument
 *     is that jazz always says which real-world object is in scope.
 *   - Every field that will exist afterwards is on the card before you commit.
 *     Long values collapse to a preview so a multi-kilobyte command does not
 *     bury the rest of the record; Ctrl+O expands them, and the expanded view
 *     wraps and scrolls rather than clipping the tail.
 *   - Irreversibility is stated in prose, not encoded in an icon.
 *   - Red is reserved for things that already broke; this is a decision being
 *     offered, so the only hue is `warning`, on the marker and the verb.
 *   - It holds perfectly still. No spinner, no pulse, no countdown: motion
 *     here would be pressure applied to an irreversible choice.
 *   - The controls sit outside the frame. The card is what *will happen*; the
 *     line below it is what *you can do*.
 */

import { TextAttributes, type BorderCharacters } from "@opentui/core";
import type { ReactNode } from "react";
import { getGlyphs, type GlyphSet } from "../../glyphs";
import { THEME } from "../../theme";
import { clipTerminalCells, sliceTerminalCells, terminalCellWidth } from "../terminal-cells";
import { COMPACT_HEIGHT, COMPACT_WIDTH, type ApprovalOverlay, type Viewport } from "../types";
import { OVERLAY_Z_INDEX } from "./centered";
import { overlayWidth, placeOverlay } from "./overlay-frame";

/** Windowed width, and the floor below which windowing stops making sense. */

/** One column of breathing room inside the frame, on each side. */
const CARD_PAD = 1;

/** Labels share a column so the values line up and read as a record. */
const LABEL_COLUMN = 11;

/** Border, header, blank, account, rule, border. Everything else scrolls. */
const FIXED_CARD_ROWS = 6;

/** Compact cards put the account in the scrollable body and use two control rows. */
const COMPACT_FIXED_CARD_ROWS = 5;
const CONTROL_ROWS = 1;
const COMPACT_CONTROL_ROWS = 2;

/**
 * Collapsed field preview, in terminal cells. Long enough to recognise the
 * command, short enough that a heredoc does not become the whole card.
 */
export const COLLAPSED_FIELD_CELLS = 120;

function displayWidth(text: string): number {
  return terminalCellWidth(text);
}

function clip(text: string, width: number): string {
  return clipTerminalCells(text, width);
}

/** A field value is one row of a record, so newlines collapse rather than wrap. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function approvalFieldNeedsExpand(value: string): boolean {
  return displayWidth(oneLine(value)) > COLLAPSED_FIELD_CELLS;
}

function collapsedFieldValue(value: string): string {
  return clip(oneLine(value), COLLAPSED_FIELD_CELLS);
}

export function wrapProse(text: string, width: number): string[] {
  const measure = Math.max(1, width);
  const words = oneLine(text)
    .split(" ")
    .filter((word) => word.length > 0);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= measure) {
      line = candidate;
      continue;
    }
    if (line.length > 0) lines.push(line);
    // A word wider than the measure is broken across rows, never clipped. On
    // this card the oversized word is typically a URL or a shell command with
    // no spaces in it — the one string the reader most needs whole.
    let rest = word;
    while (displayWidth(rest) > measure) {
      const head = sliceTerminalCells(rest, measure);
      if (head.length === 0) break;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    line = rest;
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * One row of the scrollable half of the card.
 *
 * Fields and prose share a list rather than occupying two fixed regions,
 * because the promise the card makes — nothing is discoverable only after
 * pressing enter — is only true if *everything* below the rule can be reached
 * by expanding and scrolling. Two regions meant one of them was clipped by
 * the frame.
 */
type BodyRow =
  | { readonly kind: "field"; readonly key: string; readonly label: string; readonly value: string }
  | { readonly kind: "prose"; readonly key: string; readonly text: string }
  | { readonly kind: "blank"; readonly key: string };

/**
 * Collapsed, a field is clipped to COLLAPSED_FIELD_CELLS so the card stays a
 * decision rather than a wall of text. Expanded, it wraps without clipping:
 * the argument that decides what runs is usually the longest one on the card,
 * and a shell command whose tail is off screen is the exact thing an approval
 * gate exists to prevent.
 */
export function approvalBodyRows(
  fields: readonly { readonly label: string; readonly value: string }[],
  consequence: readonly string[],
  valueWidth: number,
  labelWidth: number,
  expanded = false,
): BodyRow[] {
  const rows: BodyRow[] = [];

  fields.forEach((field, index) => {
    const label = clip(oneLine(field.label), labelWidth);
    const value = expanded ? field.value : collapsedFieldValue(field.value);
    wrapProse(value, valueWidth).forEach((line, lineIndex) => {
      rows.push({
        kind: "field",
        key: `field:${String(index)}:${String(lineIndex)}`,
        // Continuation rows keep the value column and drop the label, so a
        // wrapped command still reads as one record entry.
        label: lineIndex === 0 ? label : "",
        value: line,
      });
    });
  });

  if (consequence.length > 0) {
    if (rows.length > 0) rows.push({ kind: "blank", key: "gap" });
    consequence.forEach((line, index) => {
      rows.push({ kind: "prose", key: `consequence:${String(index)}`, text: line });
    });
  }

  return rows;
}

/**
 * The card's title as a person would say it. Two-phase tools arrive as
 * `execute write file`; the `execute` is plumbing, and the reader wants the verb.
 */
export function approvalTitle(action: string): string {
  const words = oneLine(action.replace(/[_.]/g, " "))
    .split(" ")
    .filter((word) => word.length > 0);
  const verb = words[0]?.toLowerCase() === "execute" && words.length > 1 ? words.slice(1) : words;
  const title = verb.join(" ");
  return title.length === 0 ? title : `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

/** The app tag is dropped when the title already opens with it (`Write file` · `write`). */
export function approvalTag(title: string, app: string): string | undefined {
  const firstWord = title.split(" ")[0]?.toLowerCase();
  return firstWord === app.toLowerCase() ? undefined : app;
}

/** Field values short enough to be words in a sentence are left alone. */
const MIN_REPEATED_VALUE_CELLS = 12;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The consequence line, without values the fields above it already show. Tools
 * write their prose for surfaces that have no field list, so it tends to repeat
 * the path or command verbatim; on the card that is the same long string twice.
 */
export function approvalConsequence(
  consequence: string,
  fields: readonly { readonly value: string }[],
): string {
  let prose = oneLine(consequence);
  for (const field of fields) {
    const value = oneLine(field.value);
    if (displayWidth(value) < MIN_REPEATED_VALUE_CELLS || !prose.includes(value)) {
      continue;
    }
    prose = prose.replace(new RegExp(`:?\\s*${escapeRegExp(value)}`, "g"), "");
  }
  prose = oneLine(prose)
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/[:,;]$/, "");
  if (prose.length > 0 && !/[.!?]$/.test(prose)) {
    prose = `${prose}.`;
  }
  return prose;
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

/** The card's size, placement, and visible body rows; `height` is what the layout reserves. */
export function approvalLayout(model: ApprovalOverlay, viewport: Viewport) {
  const compact = viewport.width < COMPACT_WIDTH || viewport.height < COMPACT_HEIGHT;

  const frame = overlayWidth(viewport);
  const { fullscreen, width } = frame;
  const inner = Math.max(8, width - 2 - CARD_PAD * 2);
  const valueWidth = Math.max(4, inner - LABEL_COLUMN);

  const consequenceText = approvalConsequence(model.consequence, model.fields);
  const consequence = consequenceText.length === 0 ? [] : wrapProse(consequenceText, inner);
  // At compact widths, expanded rows keep long fields inspectable without
  // hiding the tail behind a shortcut that would not fit in the legend.
  const expanded = model.expanded === true || compact;
  const expandable = model.fields.some((field) => approvalFieldNeedsExpand(field.value));
  const accountRows: BodyRow[] = compact
    ? wrapProse(model.account, valueWidth).map((line, index) => ({
        kind: "field",
        key: `account:${String(index)}`,
        label: index === 0 ? "Account" : "",
        value: line,
      }))
    : [];
  const bodyRows = [
    ...accountRows,
    ...approvalBodyRows(model.fields, consequence, valueWidth, LABEL_COLUMN - 1, expanded),
  ];
  const fixedCardRows = compact ? COMPACT_FIXED_CARD_ROWS : FIXED_CARD_ROWS;
  const controlRows = compact ? COMPACT_CONTROL_ROWS : CONTROL_ROWS;
  const windowedHeight = fixedCardRows + bodyRows.length + controlRows;
  const placement = placeOverlay(viewport, frame, windowedHeight);
  const { height, left, top } = placement;
  const cardHeight = Math.max(1, height - controlRows);

  // Everything below the rule is on screen before you commit — so when the
  // viewport cannot hold it all the region scrolls rather than being cut short.
  const bodyCapacity = Math.max(1, cardHeight - fixedCardRows);
  const maxBodyOffset = Math.max(0, bodyRows.length - bodyCapacity);
  const bodyScrolls = maxBodyOffset > 0;
  const bodyOffset = Math.max(0, Math.min(model.fieldOffset ?? 0, maxBodyOffset));
  const visibleBody = bodyRows.slice(bodyOffset, bodyOffset + bodyCapacity);
  const bodyPad = Math.max(0, bodyCapacity - visibleBody.length);
  const belowCount = Math.max(0, bodyRows.length - (bodyOffset + visibleBody.length));

  return {
    fullscreen,
    compact,
    width,
    inner,
    valueWidth,
    expanded,
    expandable,
    height,
    cardHeight,
    bodyCapacity,
    bodyScrolls,
    visibleBody,
    bodyPad,
    belowCount,
    left,
    top,
  };
}

export interface ApprovalProps {
  readonly model: ApprovalOverlay;
  readonly viewport: Viewport;
}

export function Approval({ model, viewport }: ApprovalProps): ReactNode {
  const glyphs = getGlyphs();
  const {
    compact,
    width,
    inner,
    valueWidth,
    expanded,
    expandable,
    height,
    cardHeight,
    bodyCapacity,
    bodyScrolls,
    visibleBody,
    bodyPad,
    belowCount,
    left,
    top,
  } = approvalLayout(model, viewport);
  const title = approvalTitle(model.action);
  const tag = approvalTag(title, model.app);

  const bodyContent = visibleBody.map((row) => {
    if (row.kind === "blank") {
      return (
        <box
          key={row.key}
          style={{ height: 1, flexShrink: 0 }}
        />
      );
    }
    if (row.kind === "prose") {
      return (
        <text
          key={row.key}
          style={{ fg: THEME.secondary, height: 1, flexShrink: 0 }}
        >
          {row.text}
        </text>
      );
    }
    return (
      <box
        key={row.key}
        style={{ height: 1, flexShrink: 0, flexDirection: "row" }}
      >
        <text style={{ fg: THEME.muted, width: LABEL_COLUMN, flexShrink: 0 }}>{row.label}</text>
        <text style={{ fg: THEME.selected }}>{row.value}</text>
      </box>
    );
  });

  const scrollHint = bodyScrolls
    ? belowCount > 0
      ? `${String(belowCount)} more below · up/down`
      : "up/down"
    : "";
  const expandHint = expandable ? `ctrl+o ${expanded ? "collapse" : "expand"}` : "";
  const rightHint = [scrollHint, expandHint, `a ${model.alwaysLabel}`]
    .filter((part) => part.length > 0)
    .join(" · ");
  const rightBudget = Math.max(0, inner - displayWidth("enter accept    esc reject"));

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
          backgroundColor: THEME.surface,
          border: true,
          customBorderChars: frameChars(glyphs),
          borderColor: THEME.border,
          paddingLeft: CARD_PAD,
          paddingRight: CARD_PAD,
        }}
      >
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.warning }}>
            <span style={{ fg: THEME.warning }}>{`${glyphs.proposed} `}</span>
            <b style={{ fg: THEME.warning }}>{clip(title, inner - 2)}</b>
          </text>
          <box style={{ flexGrow: 1 }} />
          {tag === undefined ? null : (
            <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(tag, inner)}</text>
          )}
        </box>

        <box style={{ height: 1, flexShrink: 0 }} />

        {compact ? null : (
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <text style={{ fg: THEME.muted, width: LABEL_COLUMN, flexShrink: 0 }}>Account</text>
            <text style={{ fg: THEME.selected }}>{clip(model.account, valueWidth)}</text>
          </box>
        )}

        <text style={{ fg: THEME.border, height: 1, flexShrink: 0 }}>
          {glyphs.divider.repeat(inner)}
        </text>

        <box style={{ height: bodyCapacity, flexShrink: 0, flexDirection: "column" }}>
          {bodyContent}
          {Array.from({ length: bodyPad }, (_, index) => (
            <box
              key={`pad:${String(index)}`}
              style={{ height: 1, flexShrink: 0 }}
            />
          ))}
        </box>
      </box>

      {compact ? (
        <box
          style={{
            height: COMPACT_CONTROL_ROWS,
            flexShrink: 0,
            flexDirection: "column",
            backgroundColor: THEME.canvas,
            paddingLeft: CARD_PAD + 1,
            paddingRight: CARD_PAD + 1,
          }}
        >
          <text>
            {model.armed ? (
              <b style={{ fg: THEME.primary }}>enter</b>
            ) : (
              <span style={{ fg: THEME.secondary, attributes: TextAttributes.DIM }}>enter</span>
            )}
            <span style={{ fg: THEME.secondary }}>{" accept"}</span>
            <span style={{ fg: THEME.muted }}>{" · "}</span>
            <b style={{ fg: THEME.selected }}>esc</b>
            <span style={{ fg: THEME.secondary }}>{" reject"}</span>
          </text>
          <text style={{ fg: THEME.muted }}>{bodyScrolls ? "up/down more · " : ""}a always</text>
        </box>
      ) : (
        <box
          style={{
            height: CONTROL_ROWS,
            flexShrink: 0,
            flexDirection: "row",
            backgroundColor: THEME.canvas,
            paddingLeft: CARD_PAD + 1,
            paddingRight: CARD_PAD + 1,
          }}
        >
          <text>
            {model.armed ? (
              <b style={{ fg: THEME.primary }}>enter</b>
            ) : (
              <span style={{ fg: THEME.secondary, attributes: TextAttributes.DIM }}>enter</span>
            )}
            <span style={{ fg: THEME.secondary }}>{" accept"}</span>
            <span style={{ fg: THEME.muted }}>{"    "}</span>
            <b style={{ fg: THEME.selected }}>esc</b>
            <span style={{ fg: THEME.secondary }}>{" reject"}</span>
          </text>
          <box style={{ flexGrow: 1 }} />
          <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(rightHint, rightBudget)}</text>
        </box>
      )}
    </box>
  );
}

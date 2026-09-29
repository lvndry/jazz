/** @jsxImportSource @opentui/react */

/**
 * The approval overlay.
 *
 * A coding agent asks to edit a file you can revert. Jazz asks to send an
 * email, write to a calendar, or post where other people read it — and there
 * is no undo for any of those. So this object breaks the visual language in
 * exactly one deliberate way: it is a panel band whose left bar is in the
 * warning hue, the only band in the product that takes it. Everything else
 * about it is quiet on purpose.
 *
 *   - The real account is rendered verbatim, because the whole trust argument
 *     is that jazz always says which real-world object is in scope.
 *   - Every field that will exist afterwards is on the card before you commit.
 *     Long values collapse to a preview so a multi-kilobyte command does not
 *     bury the rest of the record; Ctrl+O expands them, and the expanded view
 *     wraps and scrolls rather than clipping the tail.
 *   - Irreversibility is stated in prose, not encoded in an icon.
 *   - Red is reserved for things that already broke; this is a decision being
 *     offered, so the only hue is `warning`, on the bar and the consequence.
 *   - It holds perfectly still. No spinner, no pulse, no countdown: motion
 *     here would be pressure applied to an irreversible choice.
 *   - The controls sit outside the band. The card is what *will happen*; the
 *     lines below it are what *you can do*: accept, always allow and reject
 *     as three choices that left and right walk and enter confirms. Focus
 *     starts on accept, so a standing grant is never one stray enter away.
 */

import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { OVERLAY_Z_INDEX } from "./centered";
import { BAND_CHROME_COLUMNS, bandStyle, overlayWidth, placeOverlay } from "./overlay-frame";
import { onAccent } from "./Question";
import { getGlyphs } from "../../glyphs";
import {
  approvalAccount,
  approvalConsequence,
  approvalTag,
  approvalTitle,
  type ApprovalDiff,
} from "../../models/approval";
import { highlightCodeLine, highlightFenceLines, type SyntaxSpan } from "../../text/syntax-spans";
import {
  clipTerminalCells,
  sliceTerminalCells,
  terminalCellWidth,
} from "../../text/terminal-cells";
import { THEME } from "../../theme";
import { blendHex } from "../../themes/registry";
import {
  COMPACT_HEIGHT,
  COMPACT_WIDTH,
  type ApprovalChoice as ApprovalChoiceName,
  type ApprovalOverlay,
  type Viewport,
} from "../types";

/** The legend under the band starts where the band's text does. */
const LEGEND_INDENT = BAND_CHROME_COLUMNS - 1;

/** Cells kept between the title and a consequence set on the same row. */
const TITLE_GAP = 3;

/** Labels share a column so the values line up and read as a record. */
const LABEL_COLUMN = 11;

/** Padding, title, padding, account, padding. Everything else scrolls. */
const PADDED_FIXED_CARD_ROWS = 5;

/** Compact cards drop the padding and put the account in the scrollable body. */
const COMPACT_FIXED_CARD_ROWS = 1;
/** The three answers on one row, then their keys: enter starts on accept, so a standing grant is never a default. */
const CONTROL_ROWS = 2;

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
  | { readonly kind: "warning"; readonly key: string; readonly text: string }
  | { readonly kind: "blank"; readonly key: string }
  | { readonly kind: "code"; readonly key: string; readonly spans: readonly SyntaxSpan[] }
  | {
      readonly kind: "diff";
      readonly key: string;
      readonly sign: "+" | "-" | " " | "@";
      readonly gutter: string;
      readonly spans: readonly SyntaxSpan[];
    };

/** The prompt the command band opens with, so it reads as a command line rather than a value. */
const COMMAND_PROMPT = "$ ";

/** How far an added or removed row's ground moves from the panel toward its status hue. */
const DIFF_TINT = 0.16;

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/** A diff row's ground: the panel tinted toward green or red, or the element tier when the panel is not a colour that can be mixed. */
function diffBackground(sign: "+" | "-" | " " | "@"): string {
  if (sign === " " || sign === "@") return THEME.surfaceStrong;
  const hue = sign === "+" ? THEME.success : THEME.error;
  return HEX_COLOR.test(THEME.surface) && HEX_COLOR.test(hue)
    ? blendHex(THEME.surface, hue, DIFF_TINT)
    : THEME.surfaceStrong;
}

/** Spans cut to a width, so a long code line ends at the band's edge instead of wrapping into the next row's colours. */
function clipSpans(spans: readonly SyntaxSpan[], width: number): SyntaxSpan[] {
  const clipped: SyntaxSpan[] = [];
  let remaining = width;
  for (const span of spans) {
    if (remaining <= 0) break;
    const text = clip(span.text, remaining);
    clipped.push({ text, fg: span.fg });
    remaining -= displayWidth(text);
  }
  return clipped;
}

/**
 * A shell command as code rows. Wrapped rather than clipped: the tail of a
 * command is exactly the part an approval exists to show.
 */
export function commandRows(command: string, width: number): BodyRow[] {
  const lines = command.split("\n").flatMap((line, lineIndex) => {
    const prefix = lineIndex === 0 ? COMMAND_PROMPT : "  ";
    const measure = Math.max(1, width - displayWidth(prefix));
    const pieces: string[] = [];
    let rest = line;
    do {
      let head = displayWidth(rest) > measure ? sliceTerminalCells(rest, measure) : rest;
      // Break after the last space that fits, so a flag or a path stays whole; a token
      // wider than the band is the only thing cut mid-way.
      const space = head.lastIndexOf(" ");
      if (head.length < rest.length && space > 0) head = head.slice(0, space + 1);
      pieces.push(head);
      rest = rest.slice(head.length);
    } while (rest.length > 0);
    return pieces.map((piece, pieceIndex) => ({
      prefix: pieceIndex === 0 ? prefix : "  ",
      text: piece,
    }));
  });
  const painted = highlightFenceLines(
    "sh",
    lines.map((line) => line.text),
  );
  return lines.map((line, index) => ({
    kind: "code",
    key: `command:${String(index)}`,
    spans: [{ text: line.prefix, fg: THEME.muted }, ...(painted[index] ?? [])],
  }));
}

/** A file change as tinted rows under a line-number gutter. */
export function diffRows(diff: ApprovalDiff, language: string, width: number): BodyRow[] {
  const widest = diff.rows.reduce((max, row) => Math.max(max, row.line ?? 0), 0);
  const gutterWidth = String(widest).length;
  return diff.rows.map((row, index) => {
    if (row.sign === "@") {
      return {
        kind: "diff",
        key: `diff:${String(index)}`,
        sign: "@",
        gutter: " ".repeat(gutterWidth + 1),
        spans: [{ text: row.text, fg: THEME.muted }],
      };
    }
    const signFg = row.sign === "+" ? THEME.success : row.sign === "-" ? THEME.error : THEME.muted;
    const gutter = `${String(row.line ?? "").padStart(gutterWidth)} `;
    const body = highlightCodeLine(row.text, language);
    const content: SyntaxSpan[] = [{ text: `${row.sign} `, fg: signFg }, ...body];
    return {
      kind: "diff",
      key: `diff:${String(index)}`,
      sign: row.sign,
      gutter,
      spans: clipSpans(content, Math.max(1, width - displayWidth(gutter))),
    };
  });
}

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
 * Whether the consequence is short enough to sit on the title row, flush right
 * in the warning hue ("can't be unsent"). A longer statement becomes prose rows
 * under the fields instead, because a sentence clipped mid-word on the most
 * important row of the card is worse than one more row.
 */
function consequenceInline(title: string, consequence: string, inner: number): boolean {
  if (consequence.length === 0) return false;
  return displayWidth(title) + TITLE_GAP + displayWidth(consequence) + 2 <= inner;
}

/** The card's size, placement, and visible body rows; `height` is what the layout reserves. */
export function approvalLayout(model: ApprovalOverlay, viewport: Viewport) {
  const compact = viewport.width < COMPACT_WIDTH || viewport.height < COMPACT_HEIGHT;

  const frame = overlayWidth(viewport);
  const { fullscreen, width } = frame;
  const inner = Math.max(8, width - BAND_CHROME_COLUMNS);
  const valueWidth = Math.max(4, inner - LABEL_COLUMN);

  const title = approvalTitle(model.action);
  // A headline replaces the tool's prose: it says the same thing in the card's own words,
  // and the fields and numbers carry the rest.
  const consequenceText =
    model.headline === undefined
      ? approvalConsequence(model.consequence, model.fields)
      : model.headline;
  const inlineConsequence = consequenceInline(title, consequenceText, inner);
  const consequence =
    consequenceText.length === 0 || inlineConsequence ? [] : wrapProse(consequenceText, inner);
  const diffStat =
    model.diff === undefined
      ? undefined
      : `+${String(model.diff.added)} −${String(model.diff.removed)}`;
  // At compact widths, expanded rows keep long fields inspectable without
  // hiding the tail behind a shortcut that would not fit in the legend.
  const expanded = model.expanded === true || compact;
  const expandable = model.fields.some((field) => approvalFieldNeedsExpand(field.value));
  const accountRows: BodyRow[] = compact
    ? wrapProse(approvalAccount(model.account, model.app), valueWidth).map((line, index) => ({
        kind: "field",
        key: `account:${String(index)}`,
        label: index === 0 ? "Account" : "",
        value: line,
      }))
    : [];
  const impactFields = model.impact === undefined ? [] : [model.impact];
  const warningRows: BodyRow[] =
    model.warning === undefined
      ? []
      : [
          { kind: "blank", key: "warning:gap" },
          ...wrapProse(model.warning, inner).map((line, index): BodyRow => ({
            kind: "warning",
            key: `warning:${String(index)}`,
            text: line,
          })),
        ];
  const commandBody: BodyRow[] =
    model.command === undefined
      ? []
      : [{ kind: "blank", key: "command:gap" }, ...commandRows(model.command.text, inner)];
  const diffBody: BodyRow[] =
    model.diff === undefined
      ? []
      : [
          { kind: "blank", key: "diff:gap" },
          ...diffRows(model.diff, model.diffLanguage ?? "", inner),
        ];
  const bodyRows = [
    ...accountRows,
    ...approvalBodyRows(
      [...model.fields, ...impactFields],
      consequence,
      valueWidth,
      LABEL_COLUMN - 1,
      expanded,
    ),
    ...commandBody,
    ...diffBody,
    ...warningRows,
  ];
  // Compact cards give their padding rows back first, then the account moves
  // into the scrolling body.
  const padded = !compact;
  const fixedCardRows = padded ? PADDED_FIXED_CARD_ROWS : COMPACT_FIXED_CARD_ROWS;
  const windowedHeight = fixedCardRows + bodyRows.length + CONTROL_ROWS;
  const placement = placeOverlay(viewport, frame, windowedHeight);
  const { height, left, top } = placement;
  const cardHeight = Math.max(1, height - CONTROL_ROWS);

  // Every resulting field is on screen before you commit — so when the viewport
  // cannot hold it all the region scrolls rather than being cut short.
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
    padded,
    width,
    inner,
    valueWidth,
    title,
    inlineConsequence: inlineConsequence ? consequenceText : undefined,
    diffStat,
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

function BlankRow({ id }: { id: string }): ReactNode {
  return (
    <box
      key={id}
      style={{ height: 1, flexShrink: 0 }}
    />
  );
}

export function Approval({ model, viewport }: ApprovalProps): ReactNode {
  const glyphs = getGlyphs();
  const {
    compact,
    padded,
    width,
    inner,
    valueWidth,
    title,
    inlineConsequence,
    diffStat,
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
  const tag = inlineConsequence === undefined ? approvalTag(title, model.app) : undefined;
  const account = approvalAccount(model.account, model.app);

  const bodyContent = visibleBody.map((row) => {
    if (row.kind === "code" || row.kind === "diff") {
      const background = row.kind === "code" ? THEME.surfaceStrong : diffBackground(row.sign);
      return (
        <box
          key={row.key}
          style={{ height: 1, flexShrink: 0, flexDirection: "row", backgroundColor: background }}
        >
          <text style={{ wrapMode: "none" }}>
            {row.kind === "diff" ? <span style={{ fg: THEME.muted }}>{row.gutter}</span> : null}
            {row.spans.map((span, index) => (
              <span
                key={String(index)}
                style={{ fg: span.fg }}
              >
                {span.text}
              </span>
            ))}
          </text>
        </box>
      );
    }
    if (row.kind === "warning") {
      return (
        <text
          key={row.key}
          style={{ fg: THEME.warning, height: 1, flexShrink: 0 }}
        >
          {row.text}
        </text>
      );
    }
    if (row.kind === "blank") {
      return (
        <BlankRow
          key={row.key}
          id={row.key}
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
  const editHint = model.editableArg === undefined ? "" : `e edit ${model.editableArg}`;
  const rightHint = [scrollHint, expandHint, editHint]
    .filter((part) => part.length > 0)
    .join(" · ");
  const acceptLabel = model.acceptLabel ?? "accept";
  const rejectLabel = model.rejectLabel ?? "reject";
  const legendWidth = Math.max(0, width - LEGEND_INDENT * 2);
  const choice = model.choice ?? "accept";
  const keysHint = `left/right choose · a always${model.trustHost === undefined ? "" : " · h host"} · esc`;
  const rightBudget = Math.max(0, legendWidth - displayWidth(keysHint) - TITLE_GAP);
  const alwaysRoom = legendWidth - displayWidth(acceptLabel) - displayWidth(rejectLabel) - 12;
  const alwaysText = displayWidth(model.alwaysLabel) <= alwaysRoom ? model.alwaysLabel : "always";
  const choiceLabels: readonly (readonly [ApprovalChoiceName, string])[] = [
    ["accept", acceptLabel],
    ["always", alwaysText],
    ...(model.trustHost === undefined
      ? []
      : ([["host", `GET ${model.trustHost}`]] as readonly (readonly [
          ApprovalChoiceName,
          string,
        ])[])),
    ["reject", rejectLabel],
  ];
  const choiceRow = (
    <text style={{ height: 1, flexShrink: 0, wrapMode: "none", truncate: true }}>
      {choiceLabels.map(([name, label], index) => {
        const focused = name === choice;
        const inert = name === "accept" && !model.armed;
        const style = focused
          ? { fg: onAccent(THEME.primary), bg: THEME.primary }
          : { fg: THEME.secondary, bg: THEME.surfaceStrong };
        const chip = ` ${label} `;
        return (
          <span key={name}>
            {index === 0 ? null : <span>{"  "}</span>}
            {inert ? (
              <span style={{ ...style, attributes: TextAttributes.DIM }}>{chip}</span>
            ) : focused ? (
              <b style={style}>{chip}</b>
            ) : (
              <span style={style}>{chip}</span>
            )}
          </span>
        );
      })}
    </text>
  );

  const titleRight =
    (inlineConsequence === undefined ? 0 : displayWidth(inlineConsequence) + TITLE_GAP) +
    (diffStat === undefined ? 0 : displayWidth(diffStat) + TITLE_GAP);
  const titleBudget = Math.max(1, inner - titleRight);

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
          ...bandStyle(glyphs, THEME.surface, THEME.warning),
        }}
      >
        {padded ? <BlankRow id="pad:top" /> : null}

        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ wrapMode: "none" }}>
            <b style={{ fg: THEME.selected }}>{clip(title, titleBudget)}</b>
          </text>
          <box style={{ flexGrow: 1 }} />
          {diffStat !== undefined ? (
            <text style={{ flexShrink: 0 }}>
              {inlineConsequence === undefined ? null : (
                <span style={{ fg: THEME.warning }}>{`${inlineConsequence}   `}</span>
              )}
              <span style={{ fg: THEME.muted }}>{diffStat}</span>
            </text>
          ) : inlineConsequence === undefined ? (
            tag === undefined ? null : (
              <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(tag, inner)}</text>
            )
          ) : (
            <text style={{ fg: THEME.warning, flexShrink: 0 }}>{inlineConsequence}</text>
          )}
        </box>

        {padded ? <BlankRow id="pad:title" /> : null}

        {compact ? null : (
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
            <text style={{ fg: THEME.muted, width: LABEL_COLUMN, flexShrink: 0 }}>Account</text>
            <text style={{ fg: THEME.selected }}>{clip(account, valueWidth)}</text>
          </box>
        )}

        <box style={{ height: bodyCapacity, flexShrink: 0, flexDirection: "column" }}>
          {bodyContent}
          {Array.from({ length: bodyPad }, (_, index) => (
            <BlankRow
              key={`pad:${String(index)}`}
              id={`pad:${String(index)}`}
            />
          ))}
        </box>

        {padded ? <BlankRow id="pad:bottom" /> : null}
      </box>

      <box
        style={{
          height: CONTROL_ROWS,
          flexShrink: 0,
          flexDirection: "column",
          backgroundColor: THEME.canvas,
          paddingLeft: LEGEND_INDENT,
          paddingRight: LEGEND_INDENT,
        }}
      >
        {choiceRow}
        <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
          <text style={{ fg: THEME.muted, wrapMode: "none", truncate: true }}>
            {compact ? clip(`${bodyScrolls ? "up/down · " : ""}${keysHint}`, inner) : keysHint}
          </text>
          <box style={{ flexGrow: 1 }} />
          {compact ? null : (
            <text style={{ fg: THEME.muted, flexShrink: 0 }}>{clip(rightHint, rightBudget)}</text>
          )}
        </box>
      </box>
    </box>
  );
}

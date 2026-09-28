/**
 * Terminal cell-width math for the fullscreen renderer: measures text in
 * display columns (not code units) via grapheme segmentation, since
 * wide/combining characters occupy a different number of terminal cells
 * than their string length would suggest.
 */

declare const Bun: {
  stringWidth(text: string): number;
};

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ELLIPSIS = "…";

export interface TextSegment {
  readonly text: string;
}

export function terminalCellWidth(text: string): number {
  return Bun.stringWidth(text);
}

export function terminalSegmentsWidth(segments: readonly TextSegment[]): number {
  return segments.reduce((total, segment) => total + terminalCellWidth(segment.text), 0);
}

export function terminalGraphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}

export function sliceTerminalCells(text: string, maxCells: number): string {
  const budget = Math.max(0, maxCells);
  let used = 0;
  let result = "";
  for (const grapheme of terminalGraphemes(text)) {
    const width = terminalCellWidth(grapheme);
    if (used + width > budget) break;
    result += grapheme;
    used += width;
  }
  return result;
}

export function sliceTerminalCellsFromEnd(text: string, maxCells: number): string {
  const budget = Math.max(0, maxCells);
  const graphemes = terminalGraphemes(text);
  let used = 0;
  let result = "";
  for (let index = graphemes.length - 1; index >= 0; index -= 1) {
    const grapheme = graphemes[index] as string;
    const width = terminalCellWidth(grapheme);
    if (used + width > budget) break;
    result = grapheme + result;
    used += width;
  }
  return result;
}

export function clipTerminalCells(text: string, maxCells: number, ellipsis = ELLIPSIS): string {
  const budget = Math.max(0, maxCells);
  if (terminalCellWidth(text) <= budget) return text;
  const ellipsisWidth = terminalCellWidth(ellipsis);
  if (budget <= ellipsisWidth) return sliceTerminalCells(text, budget);
  return `${sliceTerminalCells(text, budget - ellipsisWidth)}${ellipsis}`;
}

export function clipTerminalCellsFromStart(
  text: string,
  maxCells: number,
  ellipsis = ELLIPSIS,
): string {
  const budget = Math.max(0, maxCells);
  if (terminalCellWidth(text) <= budget) return text;
  const ellipsisWidth = terminalCellWidth(ellipsis);
  if (budget <= ellipsisWidth) return sliceTerminalCellsFromEnd(text, budget);
  return `${ellipsis}${sliceTerminalCellsFromEnd(text, budget - ellipsisWidth)}`;
}

export function fitTerminalSegments<Segment extends TextSegment>(
  segments: readonly Segment[],
  maxCells: number,
): Segment[] {
  const fitted: Segment[] = [];
  let remaining = Math.max(0, maxCells);
  for (const segment of segments) {
    if (remaining === 0) break;
    const width = terminalCellWidth(segment.text);
    if (width <= remaining) {
      fitted.push(segment);
      remaining -= width;
      continue;
    }
    const text = sliceTerminalCells(segment.text, remaining);
    if (text.length > 0) fitted.push({ ...segment, text });
    break;
  }
  return fitted;
}

// Word-aware wrap that never drops a character (spaces included), so a
// caret tracked by counting into the joined output never drifts.
export function wrapTerminalCells(text: string, maxCells: number): string[] {
  const width = Math.max(1, maxCells);
  const lines: string[] = [];
  let line: string[] = [];
  let used = 0;
  let breakIndex = -1;
  let breakUsed = 0;
  for (const grapheme of terminalGraphemes(text)) {
    const graphemeWidth = terminalCellWidth(grapheme);
    while (used > 0 && used + graphemeWidth > width) {
      if (breakIndex > 0) {
        lines.push(line.slice(0, breakIndex).join(""));
        line = line.slice(breakIndex);
        used -= breakUsed;
        breakIndex = -1;
        breakUsed = 0;
      } else {
        lines.push(line.join(""));
        line = [];
        used = 0;
      }
    }
    line.push(grapheme);
    used += graphemeWidth;
    if (/^\s$/.test(grapheme)) {
      breakIndex = line.length;
      breakUsed = used;
    }
  }
  if (line.length > 0) lines.push(line.join(""));
  return lines.length > 0 ? lines : [""];
}

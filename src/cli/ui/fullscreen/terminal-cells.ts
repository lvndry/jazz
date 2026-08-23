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
  let total = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) continue;
    total += terminalCellWidth(segment.text);
  }
  return total;
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

export function wrapTerminalCells(text: string, maxCells: number): string[] {
  const width = Math.max(1, maxCells);
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const grapheme of terminalGraphemes(text)) {
    const graphemeWidth = terminalCellWidth(grapheme);
    if (used > 0 && used + graphemeWidth > width) {
      lines.push(line);
      line = "";
      used = 0;
    }
    line += grapheme;
    used += graphemeWidth;
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

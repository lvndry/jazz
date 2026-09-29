/**
 * Word wrapping for styled terminal text. Preserves styles and grapheme boundaries,
 * with a single pass over oversized words so long URLs remain linear to wrap.
 */
import { terminalCellWidth, wrapTerminalCells } from "./terminal-cells";

/** Anything that carries text and a style the wrapper must not split. */
export interface StyledText {
  readonly text: string;
}

/**
 * Greedy word wrap that survives inline styling: lines break between words,
 * not between spans, so a bold run that crosses a wrap point stays bold on
 * both rows. Adjacent spans with the same style are merged as they land.
 *
 * A newline is a hard break, and two in a row give an empty line, which is how
 * a paragraph break survives. A single word wider than the measure is broken
 * rather than allowed past the edge, so a long URL cannot break the column.
 * Widths are terminal cells, so wide characters and emoji count as two.
 */
export function wrapStyledSpans<Span extends StyledText>(
  spans: readonly Span[],
  measure: number,
  sameStyle: (previous: Span, current: Span) => boolean,
): Span[][] {
  const width = Math.max(1, measure);
  const lines: Span[][] = [];
  let line: Span[] = [];
  let used = 0;

  const push = (span: Span): void => {
    const last = line[line.length - 1];
    if (last !== undefined && sameStyle(last, span)) {
      line[line.length - 1] = { ...last, text: last.text + span.text };
      return;
    }
    line.push(span);
  };

  const breakLine = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };

  for (const span of spans) {
    const hardLines = span.text.split("\n");
    for (const [index, hardLine] of hardLines.entries()) {
      if (index > 0) {
        breakLine();
      }
      for (const word of hardLine.split(/(\s+)/)) {
        if (word.length === 0) {
          continue;
        }
        const size = terminalCellWidth(word);
        if (/^\s+$/.test(word)) {
          if (used > 0 && used + size <= width) {
            push({ ...span, text: word });
            used += size;
          }
          continue;
        }
        if (used > 0 && used + size > width) {
          breakLine();
        }
        if (size <= width) {
          push({ ...span, text: word });
          used += size;
          continue;
        }
        const pieces = wrapTerminalCells(word, width);
        for (const [pieceIndex, text] of pieces.entries()) {
          if (pieceIndex > 0) breakLine();
          push({ ...span, text });
          used += terminalCellWidth(text);
        }
      }
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines.length > 0 ? lines : [[]];
}

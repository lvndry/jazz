/**
 * @fileoverview Where math sits inside Markdown prose.
 *
 * `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and bare `\begin{align}…\end{align}` are the ways a model
 * writes a formula. A lone `$` is far more often a price than a delimiter, so the single-dollar
 * form follows Pandoc's rule: the opener is followed by a non-space, the closer is preceded by
 * one and is not followed by a letter or digit. `$5 and $10` therefore stays text.
 */

import { DISPLAY_ENVIRONMENTS, latexToUnicode } from "./latex-to-unicode";

export interface InlineMathMatch {
  readonly source: string;
  /** The text as written around it, for a renderer that keeps the syntax visible. */
  readonly open: string;
  readonly close: string;
  /** Index just past the closing delimiter. */
  readonly end: number;
}

export interface DisplayMathMatch {
  readonly source: string;
  readonly open: string;
  readonly close: string;
  /** Index of the first line after the block. */
  readonly nextLine: number;
}

function hasContent(source: string): boolean {
  return source.trim().length > 0;
}

function matchSingleDollar(text: string, index: number): InlineMathMatch | undefined {
  const following = text[index + 1];
  if (following === undefined || /\s/.test(following) || following === "$") {
    return undefined;
  }
  for (let position = index + 1; position < text.length; position += 1) {
    const character = text[position];
    if (character === "\\") {
      position += 1;
      continue;
    }
    if (character === "\n" && text[position + 1] === "\n") {
      return undefined;
    }
    if (character !== "$") {
      continue;
    }
    const previous = text[position - 1] ?? "";
    if (/\s/.test(previous)) {
      return undefined;
    }
    if (/[\p{L}\p{N}]/u.test(text[position + 1] ?? "")) {
      continue;
    }
    return { source: text.slice(index + 1, position), open: "$", close: "$", end: position + 1 };
  }
  return undefined;
}

/** The inline formula that starts at `index`, if one does. */
export function matchInlineMath(text: string, index: number): InlineMathMatch | undefined {
  if (text.startsWith("\\(", index)) {
    const close = text.indexOf("\\)", index + 2);
    const source = close === -1 ? "" : text.slice(index + 2, close);
    return hasContent(source) ? { source, open: "\\(", close: "\\)", end: close + 2 } : undefined;
  }
  if (text[index] !== "$") {
    return undefined;
  }
  if (text.startsWith("$$", index)) {
    const close = text.indexOf("$$", index + 2);
    const source = close === -1 ? "" : text.slice(index + 2, close);
    return hasContent(source) ? { source, open: "$$", close: "$$", end: close + 2 } : undefined;
  }
  return matchSingleDollar(text, index);
}

const ONE_LINE_DOLLARS = /^\s*\$\$(.+?)\$\$\s*$/;
const ONE_LINE_BRACKETS = /^\s*\\\[(.+?)\\\]\s*$/;
const OPEN_DOLLARS = /^\s*\$\$(.*)$/;
const OPEN_BRACKETS = /^\s*\\\[(.*)$/;
const BEGIN_ENVIRONMENT = /^\s*\\begin\{([A-Za-z]+\*?)\}/;

function matchDelimitedBlock(
  lines: readonly string[],
  index: number,
  open: string,
  close: string,
  opener: RegExp,
): DisplayMathMatch | undefined {
  const first = opener.exec(lines[index] ?? "")?.[1] ?? "";
  if (first.includes(close)) {
    return undefined;
  }
  const collected = [first];
  for (let position = index + 1; position < lines.length; position += 1) {
    const line = lines[position] ?? "";
    const closeAt = line.indexOf(close);
    if (closeAt === -1) {
      collected.push(line);
      continue;
    }
    if (line.slice(closeAt + close.length).trim().length > 0) {
      return undefined;
    }
    collected.push(line.slice(0, closeAt));
    const source = collected.join("\n").trim();
    return hasContent(source) ? { source, open, close, nextLine: position + 1 } : undefined;
  }
  return undefined;
}

function matchEnvironmentBlock(
  lines: readonly string[],
  index: number,
): DisplayMathMatch | undefined {
  const name = BEGIN_ENVIRONMENT.exec(lines[index] ?? "")?.[1];
  if (name === undefined || !DISPLAY_ENVIRONMENTS.has(name)) {
    return undefined;
  }
  const end = `\\end{${name}}`;
  const collected: string[] = [];
  for (let position = index; position < lines.length; position += 1) {
    const line = lines[position] ?? "";
    collected.push(line);
    if (line.includes(end)) {
      const source = collected.join("\n").trim();
      return { source, open: "", close: "", nextLine: position + 1 };
    }
  }
  return undefined;
}

/**
 * The display formula that starts on `lines[index]`, if one does and it is closed. A block still
 * open (a streaming answer) is not math yet, so it reads as the text it is until it closes.
 */
export function matchDisplayMath(
  lines: readonly string[],
  index: number,
): DisplayMathMatch | undefined {
  const line = lines[index] ?? "";
  const oneLineDollars = ONE_LINE_DOLLARS.exec(line);
  if (oneLineDollars !== null) {
    return {
      source: (oneLineDollars[1] ?? "").trim(),
      open: "$$",
      close: "$$",
      nextLine: index + 1,
    };
  }
  const oneLineBrackets = ONE_LINE_BRACKETS.exec(line);
  if (oneLineBrackets !== null) {
    return {
      source: (oneLineBrackets[1] ?? "").trim(),
      open: "\\[",
      close: "\\]",
      nextLine: index + 1,
    };
  }
  if (OPEN_DOLLARS.test(line)) {
    return matchDelimitedBlock(lines, index, "$$", "$$", OPEN_DOLLARS);
  }
  if (OPEN_BRACKETS.test(line)) {
    return matchDelimitedBlock(lines, index, "\\[", "\\]", OPEN_BRACKETS);
  }
  return matchEnvironmentBlock(lines, index);
}

/**
 * Every formula in `markdown` replaced by `render(unicode, display)`, for surfaces that show
 * Markdown as text. Code is expected to be set aside already.
 */
export function convertMathInMarkdown(
  markdown: string,
  render: (unicode: string, display: boolean) => string,
): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const block = matchDisplayMath(lines, index);
    if (block === undefined) {
      kept.push(lines[index] ?? "");
      index += 1;
      continue;
    }
    kept.push(render(latexToUnicode(block.source), true));
    index = block.nextLine;
  }
  const text = kept.join("\n");
  let converted = "";
  let position = 0;
  while (position < text.length) {
    const character = text[position];
    if (character === "\\" && text[position + 1] !== "(") {
      converted += text.slice(position, position + 2);
      position += 2;
      continue;
    }
    const inline =
      character === "$" || character === "\\" ? matchInlineMath(text, position) : undefined;
    if (inline === undefined) {
      converted += character ?? "";
      position += 1;
      continue;
    }
    converted += render(latexToUnicode(inline.source).replace(/\s*\n\s*/g, " "), false);
    position = inline.end;
  }
  return converted;
}

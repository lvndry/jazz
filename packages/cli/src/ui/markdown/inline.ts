import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { latexToUnicode } from "@jazz/core/utils/latex-to-unicode";
import { matchInlineMath } from "@jazz/core/utils/math-markdown";
import { emojify } from "node-emoji";
import { getGlyphs, type GlyphSet } from "../glyphs";
import {
  markedSpan,
  type InlineMarks,
  type MarkdownRole,
  type MarkdownSpan,
  type MarkdownSyntax,
} from "./spans";

export interface InlineOptions {
  readonly glyphs?: GlyphSet;
  readonly syntax?: MarkdownSyntax;
}

interface InlineContext {
  readonly role: MarkdownRole;
  readonly glyphs: GlyphSet;
  readonly syntax: MarkdownSyntax;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9]/.test(character);
}

function delimiterRunLength(text: string, index: number, marker: "*" | "_"): number {
  let length = 0;
  while (text[index + length] === marker) {
    length += 1;
  }
  return length;
}

function skipCodeSpan(text: string, index: number): number {
  if (text[index] !== "`") {
    return index;
  }
  const close = text.indexOf("`", index + 1);
  return close === -1 ? index + 1 : close + 1;
}

function findDelimiterClose(text: string, from: number, marker: string): number {
  let index = from;
  const runCharacter = marker[0];
  while (index < text.length) {
    index = skipCodeSpan(text, index);
    if (index >= text.length) {
      break;
    }
    if (text.startsWith(marker, index) && (runCharacter === "*" || runCharacter === "_")) {
      const run = delimiterRunLength(text, index, runCharacter);
      if (run === marker.length) {
        return index;
      }
      index += run;
      continue;
    }
    if (text.startsWith(marker, index)) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/** An underscore flanked by letters or digits is part of a word (`bail_logement_loue`), never emphasis. */
function canOpenUnderscoreItalic(text: string, index: number): boolean {
  return !isWordCharacter(text[index - 1]);
}

function canCloseUnderscoreItalic(text: string, closeIndex: number): boolean {
  return !isWordCharacter(text[closeIndex + 1]);
}

function findUnderscoreItalicClose(text: string, from: number): number {
  let index = from;
  while (index < text.length) {
    index = skipCodeSpan(text, index);
    if (index >= text.length) {
      break;
    }
    if (text[index] === "_") {
      const run = delimiterRunLength(text, index, "_");
      if (run === 1 && canCloseUnderscoreItalic(text, index)) {
        return index;
      }
      index += run;
      continue;
    }
    index += 1;
  }
  return -1;
}

function matchLink(
  text: string,
  index: number,
): { readonly label: string; readonly url: string; readonly end: number } | undefined {
  if (text[index] !== "[") {
    return undefined;
  }
  const close = text.indexOf("]", index + 1);
  if (close === -1 || text[close + 1] !== "(") {
    return undefined;
  }
  const urlEnd = text.indexOf(")", close + 2);
  if (urlEnd === -1) {
    return undefined;
  }
  return {
    label: text.slice(index + 1, close),
    url: text.slice(close + 2, urlEnd).trim(),
    end: urlEnd + 1,
  };
}

/** Punctuation that ends a sentence rather than a URL: `see https://x.dev.` */
const URL_TRAILING_PUNCTUATION = /[.,;:!?'"*_]+$/;

function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

/**
 * A URL written out in prose, or in CommonMark's `<https://…>` autolink form.
 * A closing parenthesis stays only when the URL opened one, so a link in
 * brackets (like this https://x.dev) does not swallow the bracket.
 */
function matchBareUrl(
  text: string,
  index: number,
): { readonly url: string; readonly end: number } | undefined {
  if (text[index] === "<") {
    const angle = /^<(https?:\/\/[^\s<>]+)>/.exec(text.slice(index));
    if (angle === null) {
      return undefined;
    }
    return { url: angle[1] ?? "", end: index + (angle[0]?.length ?? 0) };
  }
  if (text[index] !== "h" || /[\w/]/.test(text[index - 1] ?? "")) {
    return undefined;
  }
  const found = /^https?:\/\/[^\s<>]+/.exec(text.slice(index));
  if (found === null) {
    return undefined;
  }
  let url = (found[0] ?? "").replace(URL_TRAILING_PUNCTUATION, "");
  while (url.endsWith(")") && count(url, "(") < count(url, ")")) {
    url = url.slice(0, -1).replace(URL_TRAILING_PUNCTUATION, "");
  }
  if (!/^https?:\/\/[^/]/.test(url)) {
    return undefined;
  }
  return { url, end: index + url.length };
}

function matchWrapped(
  text: string,
  index: number,
  open: string,
  close: string,
): { readonly inner: string; readonly end: number } | undefined {
  if (!text.startsWith(open, index)) {
    return undefined;
  }
  const closeAt = text.indexOf(close, index + open.length);
  if (closeAt === -1) {
    return undefined;
  }
  return { inner: text.slice(index + open.length, closeAt), end: closeAt + close.length };
}

const LINE_BREAK = /^<br\s*\/?>/i;

/**
 * A path on this machine written out in prose: absolute, `~/…`, or an explicit
 * `./` / `../` relative path, with an optional `:line` or `:line:col`. The
 * lookbehind keeps a path from being found inside a URL or a word (`and/or`).
 */
const FILE_PATH =
  /(?<![:\w/])(\/(?!\/)(?:[\w.-]+\/)*[\w.-]+|~(?:\/[\w.-]+)+|\.\.?\/(?:[\w.-]+\/)*[\w.-]+)(:\d+(?::\d+)?)?/g;

/** A `file://` target for an absolute or home path; a relative path cannot be resolved at click time. */
function fileUrl(filePath: string, position: string | undefined): string | undefined {
  let absolute: string | undefined;
  if (filePath === "~" || filePath.startsWith("~/")) {
    absolute = path.join(os.homedir(), filePath.slice(1));
  } else if (path.isAbsolute(filePath)) {
    absolute = filePath;
  }
  if (absolute === undefined) {
    return undefined;
  }
  return `${pathToFileURL(absolute).href}${position ?? ""}`;
}

const EMOJI_SHORTCODE = /:[\w+-]+:/;

/**
 * Plain prose between the markup: emoji shortcodes become emoji, paths become
 * file links, and `‹n›` citations drop to the citation role, because a
 * citation is a pointer, not prose.
 */
function plainSpans(text: string, marks: InlineMarks, context: InlineContext): MarkdownSpan[] {
  const expanded = text.includes(":") && EMOJI_SHORTCODE.test(text) ? emojify(text) : text;
  if (!expanded.includes("/")) {
    return citationSpans(expanded, marks, context);
  }
  const spans: MarkdownSpan[] = [];
  let last = 0;
  for (const found of expanded.matchAll(FILE_PATH)) {
    const start = found.index ?? 0;
    if (start > last) {
      spans.push(...citationSpans(expanded.slice(last, start), marks, context));
    }
    const target = fileUrl(found[1] ?? "", found[2]);
    spans.push({
      ...markedSpan(found[0], "link", marks),
      ...(target === undefined ? {} : { link: target }),
    });
    last = start + found[0].length;
  }
  if (last < expanded.length) {
    spans.push(...citationSpans(expanded.slice(last), marks, context));
  }
  return spans;
}

const citationPatterns = new Map<string, RegExp>();

function citationPattern(open: string, close: string): RegExp {
  const cacheKey = `${open}\0${close}`;
  let pattern = citationPatterns.get(cacheKey);
  if (pattern === undefined) {
    pattern = new RegExp(`(${open}[^${close}]*${close})`);
    citationPatterns.set(cacheKey, pattern);
  }
  return pattern;
}

function citationSpans(text: string, marks: InlineMarks, context: InlineContext): MarkdownSpan[] {
  const { citeOpen, citeClose } = context.glyphs;
  if (!text.includes(citeOpen)) {
    return [markedSpan(text, context.role, marks)];
  }
  return text
    .split(citationPattern(citeOpen, citeClose))
    .filter((piece) => piece.length > 0)
    .map((piece) => markedSpan(piece, piece.startsWith(citeOpen) ? "cite" : context.role, marks));
}

function pushSyntax(spans: MarkdownSpan[], text: string, context: InlineContext): void {
  if (context.syntax === "hybrid") {
    spans.push({ text, role: "muted" });
  }
}

function parseInline(text: string, marks: InlineMarks, context: InlineContext): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = (): void => {
    if (plain.length === 0) {
      return;
    }
    spans.push(...plainSpans(plain, marks, context));
    plain = "";
  };

  const takeMarked = (
    inner: string,
    extra: InlineMarks,
    delimiters: { readonly open: string; readonly close: string },
    nextIndex: number,
  ): void => {
    flushPlain();
    pushSyntax(spans, delimiters.open, context);
    if (inner.length > 0) {
      spans.push(...parseInline(inner, { ...marks, ...extra }, context));
    }
    pushSyntax(spans, delimiters.close, context);
    index = nextIndex;
  };

  while (index < text.length) {
    const math =
      text[index] === "$" || text[index] === "\\" ? matchInlineMath(text, index) : undefined;
    if (math !== undefined) {
      flushPlain();
      pushSyntax(spans, math.open, context);
      const shown = latexToUnicode(math.source).replace(/\s*\n\s*/g, " ");
      spans.push(markedSpan(shown.length > 0 ? shown : math.source, context.role, marks));
      pushSyntax(spans, math.close, context);
      index = math.end;
      continue;
    }

    if (text[index] === "\\" && index + 1 < text.length) {
      plain += context.syntax === "hybrid" ? text.slice(index, index + 2) : text[index + 1];
      index += 2;
      continue;
    }

    const lineBreak = text[index] === "<" ? LINE_BREAK.exec(text.slice(index, index + 6)) : null;
    if (lineBreak !== null) {
      plain += "\n";
      index += lineBreak[0].length;
      continue;
    }

    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close !== -1) {
        flushPlain();
        const code = text.slice(index + 1, close);
        if (code.length > 0) {
          pushSyntax(spans, "`", context);
          spans.push({ text: code, role: "code" });
          pushSyntax(spans, "`", context);
        }
        index = close + 1;
        continue;
      }
    }

    const link = matchLink(text, index);
    if (link !== undefined) {
      flushPlain();
      const target = link.url.length > 0 ? { link: link.url } : {};
      if (context.syntax === "hybrid") {
        spans.push({ text: "[", role: "muted" });
        spans.push({ text: link.label, role: "link", underline: true, ...target });
        spans.push({ text: "](", role: "muted" });
        spans.push({ text: link.url, role: "muted", ...target });
        spans.push({ text: ")", role: "muted" });
      } else if (link.label.length > 0) {
        spans.push({ text: link.label, role: "link", underline: true, ...target });
      }
      index = link.end;
      continue;
    }

    const bare = matchBareUrl(text, index);
    if (bare !== undefined) {
      flushPlain();
      const shown = context.syntax === "hybrid" ? text.slice(index, bare.end) : bare.url;
      spans.push({ text: shown, role: "link", underline: true, link: bare.url });
      index = bare.end;
      continue;
    }

    const character = text[index];
    const under = character === "<" ? matchWrapped(text, index, "<u>", "</u>") : undefined;
    if (under !== undefined) {
      takeMarked(under.inner, { underline: true }, { open: "<u>", close: "</u>" }, under.end);
      continue;
    }

    const struck = character === "~" ? matchWrapped(text, index, "~~", "~~") : undefined;
    if (struck !== undefined) {
      takeMarked(struck.inner, { strikethrough: true }, { open: "~~", close: "~~" }, struck.end);
      continue;
    }

    const stars = delimiterRunLength(text, index, "*");
    if (stars >= 1) {
      const size = Math.min(stars, 3);
      const marker = "*".repeat(size);
      const closeAt = findDelimiterClose(text, index + size, marker);
      if (closeAt !== -1) {
        const extra: InlineMarks =
          size === 3
            ? { bold: true, italic: true }
            : size === 2
              ? { bold: true }
              : { italic: true };
        takeMarked(
          text.slice(index + size, closeAt),
          extra,
          { open: marker, close: marker },
          closeAt + size,
        );
        continue;
      }
    }

    const unders = delimiterRunLength(text, index, "_");
    if (unders >= 2) {
      const size = Math.min(unders, 3);
      const marker = "_".repeat(size);
      const closeAt = findDelimiterClose(text, index + size, marker);
      if (closeAt !== -1) {
        const extra: InlineMarks = size === 3 ? { bold: true, italic: true } : { bold: true };
        takeMarked(
          text.slice(index + size, closeAt),
          extra,
          { open: marker, close: marker },
          closeAt + size,
        );
        continue;
      }
    }
    if (unders === 1 && canOpenUnderscoreItalic(text, index)) {
      const closeAt = findUnderscoreItalicClose(text, index + 1);
      if (closeAt !== -1) {
        takeMarked(
          text.slice(index + 1, closeAt),
          { italic: true },
          { open: "_", close: "_" },
          closeAt + 1,
        );
        continue;
      }
    }

    plain += text[index];
    index += 1;
  }

  flushPlain();
  return spans;
}

/** Inline emphasis, code, math, links, paths, emoji shortcodes and citations, as styled spans. */
export function parseInlineMarkdown(
  text: string,
  role: MarkdownRole,
  options: InlineOptions = {},
): MarkdownSpan[] {
  return parseInline(
    text,
    {},
    { role, glyphs: options.glyphs ?? getGlyphs(), syntax: options.syntax ?? "rendered" },
  );
}

/**
 * Fence and patch colouring that stays inside the transcript's row model.
 *
 * OpenTUI's `<code>` and `<diff>` are better editors of those objects than
 * anything here, and they are the wrong host: they need tree-sitter, they
 * occupy a variable-height renderable, and they would take the transcript out
 * of "a frame is a pure function of rows". So the three syntax roles and the
 * added/removed hues are applied here as spans. The widgets stay unused for
 * the same reasons `<markdown>` and `<textarea>` do.
 *
 * A real language server is not on the table for the same reason: it would
 * leave the row model. Fences and expanded bodies carry comment and string
 * state across lines so a `/*` that opens on one row still paints the next.
 */

import chalk from "chalk";
import { THEME } from "../theme";

export interface SyntaxSpan {
  readonly text: string;
  readonly fg: string;
}

const KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "def",
  "default",
  "defer",
  "delete",
  "do",
  "done",
  "elif",
  "else",
  "enum",
  "esac",
  "except",
  "export",
  "extends",
  "fi",
  "finally",
  "fn",
  "for",
  "from",
  "function",
  "go",
  "if",
  "impl",
  "implements",
  "import",
  "in",
  "interface",
  "lambda",
  "let",
  "match",
  "mod",
  "new",
  "not",
  "or",
  "package",
  "pass",
  "private",
  "pub",
  "public",
  "raise",
  "return",
  "static",
  "struct",
  "switch",
  "then",
  "throw",
  "trait",
  "try",
  "type",
  "typeof",
  "use",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const LITERALS = new Set(["true", "false", "null", "undefined", "None", "True", "False", "nil"]);

function fenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function looksLikeUnifiedDiff(language: string, lines: readonly string[]): boolean {
  const name = fenceLanguage(language);
  if (name === "diff" || name === "patch") return true;
  let markers = 0;
  let header = false;
  for (const line of lines) {
    if (
      line.startsWith("diff --git ") ||
      line.startsWith("+++ ") ||
      line.startsWith("--- ") ||
      line.startsWith("@@")
    ) {
      header = true;
    }
    if (/^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---")) {
      markers += 1;
    }
  }
  return header && markers >= 2;
}

export function highlightDiffLine(line: string): readonly SyntaxSpan[] {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) {
    return [{ text: line, fg: THEME.secondary }];
  }
  if (line.startsWith("@@")) {
    return [{ text: line, fg: THEME.muted }];
  }
  const marker = line[0];
  if (marker === "+" || marker === "-" || marker === " ") {
    const markerFg =
      marker === "+" ? THEME.success : marker === "-" ? THEME.error : THEME.secondary;
    const body = line.slice(1);
    if (body.length === 0) return [{ text: marker, fg: markerFg }];
    return [{ text: marker, fg: markerFg }, ...highlightCodeLine(body)];
  }
  return highlightCodeLine(line);
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function identifierColor(word: string): string {
  if (KEYWORDS.has(word)) return THEME.syntaxStructure;
  if (LITERALS.has(word)) return THEME.syntaxValue;
  if (/^[A-Z]/.test(word)) return THEME.syntaxType;
  return THEME.selected;
}

function pushSpan(spans: SyntaxSpan[], text: string, fg: string): void {
  if (text.length === 0) return;
  const last = spans[spans.length - 1];
  if (last !== undefined && last.fg === fg) {
    spans[spans.length - 1] = { text: last.text + text, fg };
    return;
  }
  spans.push({ text, fg });
}

type StringQuote = '"' | "'" | "`";

type LexerMode =
  | { readonly kind: "code" }
  | { readonly kind: "blockComment" }
  | { readonly kind: "string"; readonly quote: StringQuote };

const CODE_MODE: LexerMode = { kind: "code" };

function isStringQuote(character: string): character is StringQuote {
  return character === '"' || character === "'" || character === "`";
}

function scanStringEnd(
  line: string,
  start: number,
  quote: StringQuote,
): { readonly end: number; readonly closed: boolean } {
  let end = start;
  while (end < line.length) {
    if (line[end] === "\\") {
      end += 2;
      continue;
    }
    if (line[end] === quote) {
      return { end: end + 1, closed: true };
    }
    end += 1;
  }
  return { end: line.length, closed: false };
}

function scanBlockCommentEnd(
  line: string,
  start: number,
): { readonly end: number; readonly closed: boolean } {
  const close = line.indexOf("*/", start);
  return close === -1 ? { end: line.length, closed: false } : { end: close + 2, closed: true };
}

function paintCodeLine(
  line: string,
  incoming: LexerMode,
): { readonly spans: readonly SyntaxSpan[]; readonly mode: LexerMode } {
  const spans: SyntaxSpan[] = [];
  let index = 0;
  let mode = incoming;

  while (index < line.length) {
    if (mode.kind === "blockComment") {
      const scanned = scanBlockCommentEnd(line, index);
      pushSpan(spans, line.slice(index, scanned.end), THEME.muted);
      index = scanned.end;
      if (!scanned.closed) break;
      mode = CODE_MODE;
      continue;
    }

    if (mode.kind === "string") {
      const scanned = scanStringEnd(line, index, mode.quote);
      pushSpan(spans, line.slice(index, scanned.end), THEME.syntaxValue);
      index = scanned.end;
      if (!scanned.closed) break;
      mode = CODE_MODE;
      continue;
    }

    const character = line[index] ?? "";
    const next = line[index + 1] ?? "";

    if (character === "/" && next === "/") {
      pushSpan(spans, line.slice(index), THEME.muted);
      break;
    }
    if (character === "#") {
      pushSpan(spans, line.slice(index), THEME.muted);
      break;
    }
    if (character === "/" && next === "*") {
      const scanned = scanBlockCommentEnd(line, index + 2);
      pushSpan(spans, line.slice(index, scanned.end), THEME.muted);
      index = scanned.end;
      if (!scanned.closed) {
        mode = { kind: "blockComment" };
        break;
      }
      continue;
    }

    if (isStringQuote(character)) {
      const scanned = scanStringEnd(line, index + 1, character);
      pushSpan(spans, line.slice(index, scanned.end), THEME.syntaxValue);
      index = scanned.end;
      if (!scanned.closed) {
        mode = { kind: "string", quote: character };
        break;
      }
      continue;
    }

    if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (end < line.length && /[0-9_.]/.test(line[end] ?? "")) end += 1;
      pushSpan(spans, line.slice(index, end), THEME.syntaxValue);
      index = end;
      continue;
    }

    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < line.length && isIdentifierPart(line[end] ?? "")) end += 1;
      const word = line.slice(index, end);
      pushSpan(spans, word, identifierColor(word));
      index = end;
      continue;
    }

    pushSpan(spans, character, THEME.secondary);
    index += 1;
  }

  return {
    spans: spans.length > 0 ? spans : [{ text: line, fg: THEME.selected }],
    mode,
  };
}

export function highlightCodeLine(line: string): readonly SyntaxSpan[] {
  return paintCodeLine(line, CODE_MODE).spans;
}

export function highlightFenceLines(
  language: string,
  lines: readonly string[],
): readonly (readonly SyntaxSpan[])[] {
  if (looksLikeUnifiedDiff(language, lines)) {
    return lines.map((line) => highlightDiffLine(line));
  }
  let mode: LexerMode = CODE_MODE;
  return lines.map((line) => {
    const painted = paintCodeLine(line, mode);
    mode = painted.mode;
    return painted.spans;
  });
}

const SOURCE_EXTENSIONS = new Set([
  "bash",
  "c",
  "cjs",
  "cpp",
  "cs",
  "cts",
  "fish",
  "go",
  "h",
  "hpp",
  "java",
  "js",
  "jsx",
  "ksh",
  "kt",
  "kts",
  "lua",
  "mjs",
  "mts",
  "php",
  "py",
  "pyw",
  "r",
  "rb",
  "rs",
  "scala",
  "sh",
  "sql",
  "swift",
  "ts",
  "tsx",
  "zig",
  "zsh",
]);

/**
 * Language tag for the lightweight highlighter, or undefined when the path
 * is prose / data and colouring would lie.
 */
export function sourceLanguageFromPath(path: string): string | undefined {
  const base = path.split(/[/\\]/).pop() ?? path;
  if (base === "Makefile" || base === "Dockerfile" || base === "Justfile") return "bash";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext) ? ext : undefined;
}

/** `file: src/app.py  import os…` — the path compactToolArguments puts first. */
export function pathFromFileArgsPreview(args: string): string | undefined {
  const match = /^file:\s+(\S+)/.exec(args.trim());
  return match?.[1];
}

export function highlightSourceAnsi(text: string, language = ""): string {
  if (text.length === 0) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return highlightFenceLines(language, lines)
    .map((spans) => spans.map((span) => chalk.hex(span.fg)(span.text)).join(""))
    .join("\n");
}

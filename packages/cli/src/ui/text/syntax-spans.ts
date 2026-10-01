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
 * Deferred layout supplies a captured palette to keep retained geometry/theme
 * epochs coherent; immediate output uses the current theme by default.
 */

import chalk from "chalk";
import { THEME, type ThemeColors } from "../theme";

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

/**
 * How a language spells a comment and a quote. The lexer is shared across
 * languages, so these are the only places where languages actually differ in
 * ways that repaint a whole line: a `//` in a shell URL, a `#` in a CSS colour
 * or a JS private field, and an apostrophe in prose are all ordinary text.
 */
interface LexicalRules {
  /** `//` line comments and `/* *\/` block comments. */
  readonly slashComments: boolean;
  /** `#` line comments, recognised only at the start of a token. */
  readonly hashComments: boolean;
  /** `--` line comments, recognised only at the start of a token. */
  readonly dashComments: boolean;
  /** Whether quotes, numbers and keywords are painted at all. */
  readonly tokens: boolean;
  /** A `'` opens a string only when it closes within a character literal's reach. */
  readonly shortSingleQuotes: boolean;
}

const HASH_LANGUAGES = new Set([
  "bash",
  "conf",
  "console",
  "dockerfile",
  "elixir",
  "ex",
  "exs",
  "fish",
  "ini",
  "ksh",
  "make",
  "makefile",
  "nix",
  "perl",
  "pl",
  "powershell",
  "ps1",
  "py",
  "pyw",
  "python",
  "r",
  "rb",
  "ruby",
  "sh",
  "shell",
  "shellsession",
  "tf",
  "toml",
  "yaml",
  "yml",
  "zsh",
]);

const SLASH_LANGUAGES = new Set([
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "csharp",
  "css",
  "cts",
  "dart",
  "go",
  "golang",
  "h",
  "hpp",
  "java",
  "javascript",
  "js",
  "json5",
  "jsonc",
  "jsx",
  "kotlin",
  "kt",
  "kts",
  "less",
  "mjs",
  "mts",
  "objc",
  "php",
  "proto",
  "rs",
  "rust",
  "scala",
  "scss",
  "swift",
  "ts",
  "tsx",
  "typescript",
  "zig",
]);

const DASH_LANGUAGES = new Set(["haskell", "hs", "lua", "psql", "sql"]);

/** Fences whose body is prose or data rather than code, where colouring would lie. */
const PLAIN_LANGUAGES = new Set([
  "log",
  "markdown",
  "md",
  "output",
  "plain",
  "plaintext",
  "text",
  "txt",
]);

/** Languages with a `'` that is not a string: Rust lifetimes, and `'` alone. */
const SHORT_QUOTE_LANGUAGES = new Set(["rs", "rust"]);

function lexicalRules(language: string): LexicalRules {
  const name = fenceLanguage(language);
  if (PLAIN_LANGUAGES.has(name)) {
    return {
      slashComments: false,
      hashComments: false,
      dashComments: false,
      tokens: false,
      shortSingleQuotes: false,
    };
  }
  if (name === "json") {
    return {
      slashComments: false,
      hashComments: false,
      dashComments: false,
      tokens: true,
      shortSingleQuotes: false,
    };
  }
  const known = HASH_LANGUAGES.has(name) || SLASH_LANGUAGES.has(name) || DASH_LANGUAGES.has(name);
  return {
    // An untagged fence could be anything, so it takes the comment forms that
    // are unambiguous at a token start and never a `//` glued to a `:`.
    slashComments: SLASH_LANGUAGES.has(name) || !known,
    hashComments: HASH_LANGUAGES.has(name) || !known,
    dashComments: DASH_LANGUAGES.has(name),
    tokens: true,
    shortSingleQuotes: SHORT_QUOTE_LANGUAGES.has(name),
  };
}

/** A token starts at the line start or after whitespace or an opening bracket. */
function atTokenStart(line: string, index: number): boolean {
  return index === 0 || /[\s([{;|&]/.test(line[index - 1] ?? "");
}

/** What a unified diff has shown of itself so far: a header line, and how many +/- lines. */
export interface DiffEvidence {
  readonly header: boolean;
  readonly markers: number;
}

const NO_DIFF_EVIDENCE: DiffEvidence = { header: false, markers: 0 };

function addDiffEvidence(evidence: DiffEvidence, line: string): DiffEvidence {
  const header =
    evidence.header ||
    line.startsWith("diff --git ") ||
    line.startsWith("+++ ") ||
    line.startsWith("--- ") ||
    line.startsWith("@@");
  const marker = /^[+-]/.test(line) && !line.startsWith("+++") && !line.startsWith("---");
  return { header, markers: evidence.markers + (marker ? 1 : 0) };
}

function isDiffLanguage(language: string): boolean {
  const name = fenceLanguage(language);
  return name === "diff" || name === "patch";
}

function evidenceIsDiff(evidence: DiffEvidence): boolean {
  return evidence.header && evidence.markers >= 2;
}

export function looksLikeUnifiedDiff(language: string, lines: readonly string[]): boolean {
  if (isDiffLanguage(language)) return true;
  return evidenceIsDiff(lines.reduce(addDiffEvidence, NO_DIFF_EVIDENCE));
}

export function highlightDiffLine(
  line: string,
  palette: Readonly<ThemeColors> = THEME,
): readonly SyntaxSpan[] {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) {
    return [{ text: line, fg: palette.secondary }];
  }
  if (line.startsWith("@@")) {
    return [{ text: line, fg: palette.muted }];
  }
  const marker = line[0];
  if (marker === "+" || marker === "-" || marker === " ") {
    const markerFg =
      marker === "+" ? palette.success : marker === "-" ? palette.error : palette.secondary;
    const body = line.slice(1);
    if (body.length === 0) return [{ text: marker, fg: markerFg }];
    return [{ text: marker, fg: markerFg }, ...highlightCodeLine(body, "", palette)];
  }
  return highlightCodeLine(line, "", palette);
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function identifierColor(word: string, palette: Readonly<ThemeColors>): string {
  if (KEYWORDS.has(word)) return palette.syntaxStructure;
  if (LITERALS.has(word)) return palette.syntaxValue;
  if (/^[A-Z]/.test(word)) return palette.syntaxType;
  return palette.selected;
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

export type LexerMode =
  | { readonly kind: "code" }
  | { readonly kind: "blockComment" }
  | { readonly kind: "string"; readonly quote: StringQuote };

const CODE_MODE: LexerMode = { kind: "code" };

/** Longest character literal, quotes included: `'\u{1F600}'`. */
const SHORT_QUOTE_REACH = 12;

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
  rules: LexicalRules,
  explicitLanguage: boolean,
  palette: Readonly<ThemeColors>,
): { readonly spans: readonly SyntaxSpan[]; readonly mode: LexerMode } {
  if (!rules.tokens) {
    return { spans: [{ text: line, fg: palette.selected }], mode: CODE_MODE };
  }
  const spans: SyntaxSpan[] = [];
  let index = 0;
  let mode = incoming;

  while (index < line.length) {
    if (mode.kind === "blockComment") {
      const scanned = scanBlockCommentEnd(line, index);
      pushSpan(spans, line.slice(index, scanned.end), palette.muted);
      index = scanned.end;
      if (!scanned.closed) break;
      mode = CODE_MODE;
      continue;
    }

    if (mode.kind === "string") {
      const scanned = scanStringEnd(line, index, mode.quote);
      pushSpan(spans, line.slice(index, scanned.end), palette.syntaxValue);
      index = scanned.end;
      if (!scanned.closed) break;
      mode = CODE_MODE;
      continue;
    }

    const character = line[index] ?? "";
    const next = line[index + 1] ?? "";

    // A tagged slash language treats every `//` outside a string as a comment.
    // Untagged, only one that starts a token does, so `https://` stays text.
    if (
      rules.slashComments &&
      character === "/" &&
      next === "/" &&
      (explicitLanguage || atTokenStart(line, index))
    ) {
      pushSpan(spans, line.slice(index), palette.muted);
      break;
    }
    if (rules.hashComments && character === "#" && atTokenStart(line, index)) {
      pushSpan(spans, line.slice(index), palette.muted);
      break;
    }
    if (rules.dashComments && character === "-" && next === "-" && atTokenStart(line, index)) {
      pushSpan(spans, line.slice(index), palette.muted);
      break;
    }
    if (rules.slashComments && character === "/" && next === "*") {
      const scanned = scanBlockCommentEnd(line, index + 2);
      pushSpan(spans, line.slice(index, scanned.end), palette.muted);
      index = scanned.end;
      if (!scanned.closed) {
        mode = { kind: "blockComment" };
        break;
      }
      continue;
    }

    if (isStringQuote(character)) {
      const scanned = scanStringEnd(line, index + 1, character);
      // `'a` in Rust is a lifetime, not the start of a string: a character
      // literal closes within a few cells or it was never one.
      if (
        character === "'" &&
        rules.shortSingleQuotes &&
        (!scanned.closed || scanned.end - index > SHORT_QUOTE_REACH)
      ) {
        pushSpan(spans, character, palette.secondary);
        index += 1;
        continue;
      }
      pushSpan(spans, line.slice(index, scanned.end), palette.syntaxValue);
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
      pushSpan(spans, line.slice(index, end), palette.syntaxValue);
      index = end;
      continue;
    }

    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < line.length && isIdentifierPart(line[end] ?? "")) end += 1;
      const word = line.slice(index, end);
      pushSpan(spans, word, identifierColor(word, palette));
      index = end;
      continue;
    }

    pushSpan(spans, character, palette.secondary);
    index += 1;
  }

  return {
    spans: spans.length > 0 ? spans : [{ text: line, fg: palette.selected }],
    mode,
  };
}

export function highlightCodeLine(
  line: string,
  language = "",
  palette: Readonly<ThemeColors> = THEME,
): readonly SyntaxSpan[] {
  return paintCodeLine(
    line,
    CODE_MODE,
    lexicalRules(language),
    fenceLanguage(language) !== "",
    palette,
  ).spans;
}

export function highlightFenceLines(
  language: string,
  lines: readonly string[],
  palette: Readonly<ThemeColors> = THEME,
): readonly (readonly SyntaxSpan[])[] {
  if (looksLikeUnifiedDiff(language, lines)) {
    return lines.map((line) => highlightDiffLine(line, palette));
  }
  const rules = lexicalRules(language);
  const explicitLanguage = fenceLanguage(language) !== "";
  let mode: LexerMode = CODE_MODE;
  return lines.map((line) => {
    const painted = paintCodeLine(line, mode, rules, explicitLanguage, palette);
    mode = painted.mode;
    return painted.spans;
  });
}

/**
 * A fence highlight that can be resumed as the fence grows. Every line but the
 * last is settled: its spans and the lexer mode after it are kept, so a
 * streaming fence costs its newest lines rather than its whole body. The last
 * line may still be growing, so it is painted fresh each time.
 */
export interface FenceHighlight {
  readonly language: string;
  /** Spans for every line of the fence, in the scheme `looksLikeUnifiedDiff` picks for all of them. */
  readonly spans: readonly (readonly SyntaxSpan[])[];
  readonly settledCode: readonly (readonly SyntaxSpan[])[];
  /** Diff spans for the settled lines, filled once the fence turns out to be a diff. */
  readonly settledDiff: readonly (readonly SyntaxSpan[])[];
  readonly modeAfterSettled: LexerMode;
  readonly evidence: DiffEvidence;
}

/**
 * Extend `previous` to `lines`, which must begin with every line `previous`
 * settled, unchanged. Anything else (a different language, fewer lines) starts
 * over. The result's `spans` equal `highlightFenceLines(language, lines)`.
 */
export function continueFenceHighlight(
  previous: FenceHighlight | undefined,
  language: string,
  lines: readonly string[],
  palette: Readonly<ThemeColors> = THEME,
): FenceHighlight {
  const resumable =
    previous !== undefined &&
    previous.language === language &&
    lines.length > previous.settledCode.length;
  const rules = lexicalRules(language);
  const explicitLanguage = fenceLanguage(language) !== "";
  const settledCode = resumable ? previous.settledCode.slice() : [];
  let mode = resumable ? previous.modeAfterSettled : CODE_MODE;
  let evidence = resumable ? previous.evidence : NO_DIFF_EVIDENCE;
  const settledCount = Math.max(0, lines.length - 1);
  for (let index = settledCode.length; index < settledCount; index += 1) {
    const line = lines[index] ?? "";
    const painted = paintCodeLine(line, mode, rules, explicitLanguage, palette);
    mode = painted.mode;
    evidence = addDiffEvidence(evidence, line);
    settledCode.push(painted.spans);
  }

  const last = lines.length > 0 ? (lines[lines.length - 1] ?? "") : undefined;
  const diff =
    isDiffLanguage(language) ||
    evidenceIsDiff(last === undefined ? evidence : addDiffEvidence(evidence, last));
  const settledDiff = resumable && diff ? previous.settledDiff.slice() : [];
  if (diff) {
    for (let index = settledDiff.length; index < settledCount; index += 1) {
      settledDiff.push(highlightDiffLine(lines[index] ?? "", palette));
    }
  }
  const settled = diff ? settledDiff : settledCode;
  const spans =
    last === undefined
      ? settled
      : [
          ...settled,
          diff
            ? highlightDiffLine(last, palette)
            : paintCodeLine(last, mode, rules, explicitLanguage, palette).spans,
        ];
  return { language, spans, settledCode, settledDiff, modeAfterSettled: mode, evidence };
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

/**
 * The path in `src/app.py  import os…` or `README.md 1–300`: the first word,
 * which compactToolArguments makes the path for every tool that acts on a file.
 */
export function pathFromFileArgsPreview(args: string): string | undefined {
  const match = /^(\S+)/.exec(args.trim());
  return match?.[1];
}

export function highlightSourceAnsi(text: string, language = ""): string {
  if (text.length === 0) return text;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return highlightFenceLines(language, lines)
    .map((spans) => spans.map((span) => chalk.hex(span.fg)(span.text)).join(""))
    .join("\n");
}

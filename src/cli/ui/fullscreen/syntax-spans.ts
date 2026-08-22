/**
 * Fence and patch colouring that stays inside the transcript's row model.
 *
 * OpenTUI's `<code>` and `<diff>` are better editors of those objects than
 * anything here, and they are the wrong host: they need tree-sitter, they
 * occupy a variable-height renderable, and they would take the transcript out
 * of "a frame is a pure function of rows". So the three syntax roles and the
 * added/removed hues are applied here as spans. The widgets stay unused for
 * the same reasons `<markdown>` and `<textarea>` do.
 */

import { THEME } from "../theme";

export interface SyntaxSpan {
  readonly text: string;
  readonly fg: string;
}

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "defer",
  "delete",
  "do",
  "elif",
  "else",
  "enum",
  "except",
  "export",
  "extends",
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
  "let",
  "match",
  "mod",
  "new",
  "package",
  "private",
  "pub",
  "public",
  "return",
  "static",
  "struct",
  "switch",
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
  if (line.startsWith("+")) {
    return [{ text: line, fg: THEME.success }];
  }
  if (line.startsWith("-")) {
    return [{ text: line, fg: THEME.error }];
  }
  return [{ text: line, fg: THEME.secondary }];
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

export function highlightCodeLine(line: string): readonly SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  let index = 0;

  while (index < line.length) {
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
      const close = line.indexOf("*/", index + 2);
      const end = close === -1 ? line.length : close + 2;
      pushSpan(spans, line.slice(index, end), THEME.muted);
      index = end;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      let end = index + 1;
      while (end < line.length) {
        if (line[end] === "\\") {
          end += 2;
          continue;
        }
        if (line[end] === character) {
          end += 1;
          break;
        }
        end += 1;
      }
      pushSpan(spans, line.slice(index, end), THEME.syntaxValue);
      index = end;
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

  return spans.length > 0 ? spans : [{ text: line, fg: THEME.selected }];
}

export function highlightFenceLines(
  language: string,
  lines: readonly string[],
): readonly (readonly SyntaxSpan[])[] {
  if (looksLikeUnifiedDiff(language, lines)) {
    return lines.map((line) => highlightDiffLine(line));
  }
  return lines.map((line) => highlightCodeLine(line));
}

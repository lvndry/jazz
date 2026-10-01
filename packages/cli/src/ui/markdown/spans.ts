/**
 * Semantic Markdown spans and their shared palette mapping. Parsers return roles
 * and marks; painters choose colors. Immediate surfaces use the current theme,
 * while retained layout indexes pass a captured palette so deferred wrapping
 * cannot mix a previous geometry/theme epoch with new global colors.
 */
import { THEME, type ThemeColors } from "../theme";

/**
 * What a run of markdown text is, rather than how it is painted. Each renderer
 * turns a role into its own colour through {@link markdownRoleColor}, so a
 * theme switch repaints every surface from the same table.
 */
export type MarkdownRole =
  "text" | "secondary" | "muted" | "border" | "code" | "link" | "cite" | "success";

export interface MarkdownSpan {
  readonly text: string;
  readonly role: MarkdownRole;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  /** Where the span points: a web URL, or a `file://` URL for a path on this machine. */
  readonly link?: string;
}

export interface InlineMarks {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

/**
 * `rendered` drops the markdown syntax once it has been applied. `hybrid`
 * keeps it on screen, dimmed, so copied text is still valid markdown.
 */
export type MarkdownSyntax = "rendered" | "hybrid";

export function sameMarkdownStyle(previous: MarkdownSpan, current: MarkdownSpan): boolean {
  return (
    previous.role === current.role &&
    previous.bold === current.bold &&
    previous.italic === current.italic &&
    previous.underline === current.underline &&
    previous.strikethrough === current.strikethrough &&
    previous.link === current.link
  );
}

export function markedSpan(text: string, role: MarkdownRole, marks: InlineMarks): MarkdownSpan {
  if (
    marks.bold !== true &&
    marks.italic !== true &&
    marks.underline !== true &&
    marks.strikethrough !== true
  ) {
    return { text, role };
  }
  return {
    text,
    role,
    ...(marks.bold === true ? { bold: true } : {}),
    ...(marks.italic === true ? { italic: true } : {}),
    ...(marks.underline === true ? { underline: true } : {}),
    ...(marks.strikethrough === true ? { strikethrough: true } : {}),
  };
}

/** Map a role through the supplied snapshot, or the current theme for immediate painting. */
export function markdownRoleColor(
  role: MarkdownRole,
  palette: Readonly<ThemeColors> = THEME,
): string {
  switch (role) {
    case "text":
      return palette.selected;
    case "secondary":
      return palette.secondary;
    case "muted":
      return palette.muted;
    case "border":
      return palette.border;
    case "code":
      return palette.syntaxValue;
    case "link":
      return palette.link;
    case "cite":
      return palette.accentDim;
    case "success":
      return palette.success;
  }
}

/**
 * @fileoverview The model's Markdown, turned into what WhatsApp and Messages can show.
 *
 * A model writes Markdown whatever the surface. Sent as-is, WhatsApp shows literal `**` and
 * `##`, and Messages shows every mark as typed. WhatsApp has a small dialect of its own
 * (`*bold*`, `_italic_`, `~strike~`, ``` for code); Messages has none, so there the marks
 * are dropped and the words kept.
 *
 * Code is set aside before anything else is touched, so a `*` inside a snippet stays a `*`.
 * Math is set aside the same way, after being rewritten as Unicode, since neither dialect has
 * a way to show TeX: `$x_i^2$` becomes `xᵢ²` and no mark inside it is read as emphasis.
 */

import { convertMathInMarkdown } from "@jazz/core/utils/math-markdown";

/** For a dialect written elsewhere (Telegram's HTML) that needs the same math rewrite. */
export { convertMathInMarkdown };

interface Protected {
  readonly text: string;
  restore(rendered: string): string;
}

/** Swap code and math for placeholders, returning a function that puts them back. */
function protectCode(
  markdown: string,
  renderBlock: (code: string, language: string) => string,
  renderInline: (code: string) => string,
  renderMath: (unicode: string, display: boolean) => string,
): Protected {
  const saved: string[] = [];
  const token = Math.random().toString(36).slice(2);
  const hold = (value: string): string => {
    saved.push(value);
    return `\u0000${token}:${saved.length - 1}\u0000`;
  };
  const withoutCode = markdown
    .replace(/```[ \t]*([\w+-]*)\n?([\s\S]*?)```/g, (_match, language: string, code: string) =>
      hold(renderBlock(code.replace(/\n$/, ""), language)),
    )
    .replace(/`([^`\n]+)`/g, (_match, code: string) => hold(renderInline(code)));
  const text = convertMathInMarkdown(withoutCode, (unicode, display) =>
    hold(renderMath(unicode, display)),
  );
  const pattern = new RegExp(`\u0000${token}:(\\d+)\u0000`, "g");
  return {
    text,
    restore: (rendered) =>
      rendered.replace(pattern, (_match, index: string) => saved[Number(index)] ?? ""),
  };
}

/** Links and list bullets are written the same way in both dialects. */
function commonStructure(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");
}

/** Headings, applied after the inline marks so the heading's own mark is not restyled. */
function headings(text: string, heading: (title: string) => string): string {
  return text.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_match, title: string) => heading(title));
}

/** Markdown → WhatsApp's `*bold*` / `_italic_` / `~strike~` / ``` dialect. */
export function markdownToWhatsApp(markdown: string): string {
  const code = protectCode(
    markdown,
    (block) => `\`\`\`\n${block}\n\`\`\``,
    (inline) => `\`${inline}\``,
    (unicode) => (unicode.includes("\n") ? `\`\`\`\n${unicode}\n\`\`\`` : unicode),
  );
  const styled = commonStructure(code.text)
    .replace(/(^|[^*])\*(?!\*)(\S|\S[^\n*]*?\S)\*(?!\*)/g, "$1_$2_")
    .replace(/\*\*([^\n*]+?)\*\*/g, "*$1*")
    .replace(/__([^\n_]+?)__/g, "*$1*")
    .replace(/~~([^\n~]+?)~~/g, "~$1~");
  return code.restore(headings(styled, (title) => `*${title}*`));
}

/** Markdown → plain text for Messages: marks dropped, words, links and code kept. */
export function markdownToPlainText(markdown: string): string {
  const code = protectCode(
    markdown,
    (block) => block,
    (inline) => inline,
    (unicode) => unicode,
  );
  const plain = commonStructure(code.text)
    .replace(/\*\*([^\n*]+?)\*\*/g, "$1")
    .replace(/__([^\n_]+?)__/g, "$1")
    .replace(/(^|[^*\w])\*(\S|\S[^\n*]*?\S)\*(?!\*)/g, "$1$2")
    .replace(/(^|[^_\w])_(\S|\S[^\n_]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~([^\n~]+?)~~/g, "$1");
  return code.restore(headings(plain, (title) => title));
}

/**
 * Markdown with its math rewritten as Unicode and everything else left as written, for a surface
 * that renders Markdown itself but has no TeX. A block that spans lines goes in a code fence so
 * its alignment survives a proportional font.
 */
export function markdownWithUnicodeMath(markdown: string): string {
  const code = protectCode(
    markdown,
    (block, language) => `\`\`\`${language}\n${block}\n\`\`\``,
    (inline) => `\`${inline}\``,
    (unicode) => (unicode.includes("\n") ? `\`\`\`\n${unicode}\n\`\`\`` : unicode),
  );
  return code.restore(code.text);
}

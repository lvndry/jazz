/**
 * Rendering helpers for Telegram's HTML message flavor.
 *
 * Pure string functions with no dependency on the bridge or the Telegram API:
 * escape user text, convert a Markdown subset to Telegram HTML, and split long
 * messages under Telegram's per-message limit.
 */

// Telegram's hard limit is 4096; split lower so HTML tags/entities added by
// markdown rendering can't push a chunk over the limit.
const TELEGRAM_SPLIT_LENGTH = 3500;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Convert a subset of Markdown to Telegram's HTML flavor. Code spans/blocks are
 * extracted first so their contents aren't treated as markup, everything else
 * is HTML-escaped, then inline styles map to well-formed tags. The paired-tag
 * regexes only ever emit balanced HTML, so parsing can't fail; sendReply still
 * falls back to plain text on any Telegram error as a belt-and-braces guard.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];
  // Per-call random token in the placeholders so they can't collide with
  // anything the user actually typed.
  const token = Math.random().toString(36).slice(2);
  const placeholder = (kind: string, index: number): string => ` ${kind}_${token}_${index} `;
  const restoreRegex = (kind: string): RegExp => new RegExp(` ${kind}_${token}_(\\d+) `, "g");

  let text = markdown.replace(
    /```[ \t]*([\w+-]*)\n?([\s\S]*?)```/g,
    (_match, language: string, code: string) => {
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      codeBlocks.push(
        `<pre><code${languageClass}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
      );
      return placeholder("CB", codeBlocks.length - 1);
    },
  );

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder("IC", inlineCodes.length - 1);
  });

  text = escapeHtml(text);
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^\n_]+?)__/g, "<b>$1</b>");
  text = text.replace(/(^|[^*])\*(\S|\S[^\n*]*?\S)\*(?!\*)/g, "$1<i>$2</i>");
  text = text.replace(/~~([^\n~]+?)~~/g, "<s>$1</s>");
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  text = text.replace(
    restoreRegex("IC"),
    (_match, index: string) => inlineCodes[Number(index)] ?? "",
  );
  text = text.replace(
    restoreRegex("CB"),
    (_match, index: string) => codeBlocks[Number(index)] ?? "",
  );
  return text;
}

export function splitForTelegram(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return ["(empty response)"];
  }

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > TELEGRAM_SPLIT_LENGTH) {
    const window = remaining.slice(0, TELEGRAM_SPLIT_LENGTH);
    const lastNewline = window.lastIndexOf("\n");
    const splitAt = lastNewline > TELEGRAM_SPLIT_LENGTH * 0.5 ? lastNewline : window.length;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

/**
 * Wrap already-plain text in a collapsed, tap-to-expand quote (Bot API 7.4+).
 * Telegram shows the first few lines and hides the rest behind an "expand"
 * affordance, which is what makes it safe to attach a long reasoning log to a
 * chat without it dominating the conversation.
 */
export function expandableBlockquote(text: string): string {
  return `<blockquote expandable>${escapeHtml(text)}</blockquote>`;
}

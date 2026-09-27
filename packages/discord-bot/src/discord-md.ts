/**
 * Discord message helpers: split under the 2000-character cap, and keep
 * `@everyone` / `@here` from firing when the model echoes them.
 *
 * Mentions of specific users are suppressed at send time via
 * `allowed_mentions: { parse: [] }` — this module only sanitizes the two
 * role-less pings that Discord still delivers even with that flag.
 */

import type { RichText, Span } from "@jazz/bot-shared/surface";

const DISCORD_SPLIT_LENGTH = 1900;

export function splitForDiscord(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return ["(empty response)"];
  }

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > DISCORD_SPLIT_LENGTH) {
    const window = remaining.slice(0, DISCORD_SPLIT_LENGTH);
    const lastNewline = window.lastIndexOf("\n");
    const splitAt = lastNewline > DISCORD_SPLIT_LENGTH * 0.5 ? lastNewline : window.length;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

/** Neutralise @everyone / @here without changing the visible text much. */
export function neutralizeBroadcastMentions(text: string): string {
  return text.replace(/@(everyone|here)/gi, "@\u200b$1");
}

export function threadNameFromPrompt(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Jazz";
  return `Jazz · ${cleaned}`.slice(0, 100);
}

/**
 * Wrap plain text in a spoiler — Discord's only click-to-reveal container, and
 * the closest analogue to Telegram's expandable quote. A literal `||` in the
 * text would close the spoiler early, so pipe pairs are separated by a
 * zero-width space; the text still reads the same.
 */
export function spoilerBlock(text: string): string {
  return `||${text.replace(/\|\|/g, "|​|")}||`;
}

/**
 * Render the shared core's `RichText` in Discord's markdown dialect.
 *
 * The only mark Discord has that the others lack is subtext (`-# `), which is what a
 * `subtle` block is for.
 */
export function renderDiscordMarkdown(body: RichText): string {
  const renderSpans = (spans: readonly Span[]): string =>
    spans
      .map((span) => {
        if (span.kind === "bold") {
          return `**${span.text}**`;
        }
        if (span.kind === "code") {
          return `\`${span.text}\``;
        }
        return span.text;
      })
      .join("");
  return body
    .map((block) => {
      switch (block.kind) {
        case "line":
          return renderSpans(block.spans);
        case "subtle":
          return `-# ${renderSpans(block.spans)}`;
        case "markdown":
          return block.text;
        case "codeBlock":
          return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
        case "quote":
          // Discord's only click-to-reveal container is a spoiler, the closest thing
          // to a quote that collapses.
          if (block.expandable === true) {
            return spoilerBlock(block.text);
          }
          return block.text
            .split("\n")
            .map((row) => `> ${row}`)
            .join("\n");
      }
    })
    .join("\n");
}

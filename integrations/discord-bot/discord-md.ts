/**
 * Discord message helpers: split under the 2000-character cap, and keep
 * `@everyone` / `@here` from firing when the model echoes them.
 *
 * Mentions of specific users are suppressed at send time via
 * `allowed_mentions: { parse: [] }` — this module only sanitizes the two
 * role-less pings that Discord still delivers even with that flag.
 */

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

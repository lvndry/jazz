/**
 * Allowlist + mention-gating for the Discord bridge.
 *
 * DMs require a user allowlist. Guild messages additionally honour channel and
 * guild allowlists, and (by default) only run when the bot is mentioned, the
 * message is a reply to the bot, or it lands in a thread the bot already has
 * a session in. That last rule is what makes a public channel safe: random
 * chatter is ignored; a thread the bot started is a conversation.
 */

export interface AccessConfig {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly allowedChannelIds: ReadonlySet<string>;
  readonly allowedGuildIds: ReadonlySet<string>;
  readonly requireMention: boolean;
}

export interface MessageAccessContext {
  readonly isDm: boolean;
  readonly isThread: boolean;
  readonly userId: string;
  readonly channelId: string;
  /** Parent channel id when `channelId` is a thread. */
  readonly parentChannelId: string | undefined;
  readonly guildId: string | undefined;
  readonly mentionedBot: boolean;
  readonly replyToBot: boolean;
  /** True when this thread already has a Jazz conversation (agent file / session). */
  readonly threadHasSession: boolean;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Parse a comma-separated list of Discord snowflakes; skip blanks and junk. */
export function parseSnowflakeList(raw: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of raw.split(",")) {
    const id = entry.trim();
    if (id.length === 0) continue;
    if (!SNOWFLAKE.test(id)) {
      console.warn(`Ignoring invalid Discord id "${id}" (expected a snowflake)`);
      continue;
    }
    ids.add(id);
  }
  return ids;
}

export function hasAnyAllowlist(config: AccessConfig): boolean {
  return (
    config.allowedUserIds.size > 0 ||
    config.allowedChannelIds.size > 0 ||
    config.allowedGuildIds.size > 0
  );
}

function channelMatchesAllowlist(
  allowedChannelIds: ReadonlySet<string>,
  channelId: string,
  parentChannelId: string | undefined,
): boolean {
  if (allowedChannelIds.size === 0) return true;
  if (allowedChannelIds.has(channelId)) return true;
  return parentChannelId !== undefined && allowedChannelIds.has(parentChannelId);
}

/**
 * Whether this sender/channel is allowed to talk to the bot at all.
 * Mention-gating is a separate check (`shouldRespond`).
 */
export function isSenderAllowed(config: AccessConfig, context: MessageAccessContext): boolean {
  if (context.isDm) {
    return config.allowedUserIds.has(context.userId);
  }

  if (config.allowedGuildIds.size > 0) {
    if (context.guildId === undefined || !config.allowedGuildIds.has(context.guildId)) {
      return false;
    }
  }

  if (
    !channelMatchesAllowlist(config.allowedChannelIds, context.channelId, context.parentChannelId)
  ) {
    return false;
  }

  if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(context.userId)) {
    return false;
  }

  // A guild message with no guild/channel/user constraint would be "anyone,
  // anywhere". The loader refuses an empty allowlist, so this is the case
  // "only users are listed" (any channel) or "only channels/guilds" (any user).
  return (
    config.allowedUserIds.size > 0 ||
    config.allowedChannelIds.size > 0 ||
    config.allowedGuildIds.size > 0
  );
}

/**
 * Whether this allowed message should actually start a run. DMs always do.
 * Guild channels default to mention/reply/thread-participation.
 */
export function shouldRespond(config: AccessConfig, context: MessageAccessContext): boolean {
  if (context.isDm) return true;
  if (!config.requireMention) return true;
  if (context.mentionedBot) return true;
  if (context.replyToBot) return true;
  return context.isThread && context.threadHasSession;
}

const MENTION_PATTERN = /<@!?(\d{17,20})>/g;

export function messageMentionsUser(content: string, userId: string): boolean {
  MENTION_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(MENTION_PATTERN)) {
    if (match[1] === userId) return true;
  }
  return false;
}

export function stripBotMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

export function parseCommand(text: string): { command: string; args: string } | undefined {
  const match = /^\/([A-Za-z0-9_]+)(?:@\S+)?\s*([\s\S]*)$/.exec(text.trim());
  const command = match?.[1];
  if (command === undefined) return undefined;
  return { command: command.toLowerCase(), args: (match?.[2] ?? "").trim() };
}

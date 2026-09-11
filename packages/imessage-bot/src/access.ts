/**
 * @fileoverview Who is allowed to talk to the agent over iMessage.
 *
 * This gate matters more here than on the other surfaces. A Telegram bot has a
 * username nobody knows and a Discord bot has to be invited to a server, but an
 * iMessage bridge answers on a phone number that is already public to everyone
 * who has ever been given it — every contact, every business, every wrong
 * number. Left open it would run a tool-using agent on behalf of a stranger.
 *
 * So: deny by default, allow only exact handles the operator listed, and never
 * infer that a group is allowed because one of its members is.
 */

/**
 * Reduce a handle to the form both sides are compared in.
 *
 * Phone numbers arrive from `chat.db` in E.164 but get written into a config
 * file by a human, who will use spaces, dashes, parentheses or a leading `00`.
 * Emails arrive in whatever case they were registered in. Punctuation and case
 * are the only differences resolved here — a bare national number cannot be
 * matched against an international one without knowing the country, so it is
 * left alone and simply will not match, which is the safe direction.
 */
export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;

  const digits = trimmed.replace(/[\s()\-.]/g, "");
  // `00` is the international prefix in most of the world and `+` is the same
  // thing; normalising one to the other lets a person write either.
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

export interface AccessConfig {
  /** Handles (phone numbers or Apple IDs) allowed to start a conversation. */
  readonly allowedHandles: ReadonlySet<string>;
  /**
   * `chat.db` rowids of group chats the agent answers in.
   *
   * Separate from `allowedHandles` on purpose: being allowed to DM the agent
   * says nothing about whether it should speak in a group that person happens
   * to have added it to, where everything it says is read by people who were
   * never allowed anything.
   */
  readonly allowedGroupChatIds: ReadonlySet<number>;
}

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface IncomingContext {
  readonly sender: string;
  readonly chatId: number;
  readonly isGroup: boolean;
}

export function decideAccess(config: AccessConfig, incoming: IncomingContext): AccessDecision {
  const sender = normalizeHandle(incoming.sender);

  if (incoming.isGroup) {
    if (!config.allowedGroupChatIds.has(incoming.chatId)) {
      return {
        allowed: false,
        reason: `group chat ${incoming.chatId} is not in IMESSAGE_ALLOWED_GROUP_CHAT_IDS`,
      };
    }
    // Inside an allowed group the participants are whoever the group contains,
    // which is not something the operator listed and not something they can
    // control — the decision to trust the group was the decision to trust them.
    return { allowed: true };
  }

  if (!config.allowedHandles.has(sender)) {
    return { allowed: false, reason: `handle ${sender} is not in IMESSAGE_ALLOWED_HANDLES` };
  }
  return { allowed: true };
}

/** Parse a comma-separated allowlist, normalising each entry. */
export function parseHandleList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeHandle(entry))
      .filter((entry) => entry.length > 0),
  );
}

export function parseChatIdList(raw: string): Set<number> {
  return new Set(
    raw
      .split(",")
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((entry) => Number.isFinite(entry)),
  );
}

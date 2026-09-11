import { normalizeHandle } from "@jazz/bot-shared/handles";

export { normalizeHandle, parseHandleList } from "@jazz/bot-shared/handles";

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

export function parseChatIdList(raw: string): Set<number> {
  return new Set(
    raw
      .split(",")
      .map((entry) => Number.parseInt(entry.trim(), 10))
      .filter((entry) => Number.isFinite(entry)),
  );
}

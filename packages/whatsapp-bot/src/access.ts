/**
 * @fileoverview Who is allowed to talk to the agent over WhatsApp.
 *
 * Same reasoning as the iMessage bridge: this answers on a personal phone
 * number that anyone who has it can write to, so the gate is deny-by-default
 * and a group is admitted on its own terms rather than because a member is
 * allowed.
 *
 * WhatsApp adds one rule the others do not need. A group here is often a family
 * or work thread with dozens of messages an hour that have nothing to do with
 * the agent, so an allowed group still requires the bot to be addressed —
 * mentioned, or replied to — before a message is treated as a question for it.
 */

/**
 * A WhatsApp address. DMs are `<number>@s.whatsapp.net`, groups `<id>@g.us`,
 * and newer accounts also appear as `<id>@lid` (a per-thread identifier
 * WhatsApp issues instead of exposing the phone number).
 */
export type Jid = string;

export function isGroupJid(jid: Jid): boolean {
  return jid.endsWith("@g.us");
}

/**
 * Reduce a JID or a hand-written phone number to one comparable form.
 *
 * A JID carries a device suffix (`:12`) on messages from a linked device and an
 * `@server` part that differs by account type, while the allow-list is written
 * by a human as a phone number. Both collapse to the digits, which is the only
 * part that identifies the same person across those forms.
 */
export function normalizeJid(value: string): string {
  const withoutServer = value.trim().toLowerCase().split("@")[0] ?? "";
  const withoutDevice = withoutServer.split(":")[0] ?? "";
  // A group id is not a phone number and must survive intact; only strip
  // punctuation from things that look like numbers.
  if (/^[\d\s()+.-]+$/.test(withoutDevice)) return withoutDevice.replace(/[\s()+.-]/g, "");
  return withoutDevice;
}

export interface AccessConfig {
  /** Numbers allowed to DM the agent, compared as digits. */
  readonly allowedNumbers: ReadonlySet<string>;
  /** Group JIDs (or their id part) the agent will speak in at all. */
  readonly allowedGroups: ReadonlySet<string>;
  /**
   * Whether an allowed group additionally requires the bot to be addressed.
   *
   * On by default. Off turns the agent into a participant that answers every
   * message in the thread, which is a deliberate and fairly loud choice.
   */
  readonly requireMentionInGroups: boolean;
}

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface IncomingContext {
  /** The chat the message is in: a person for a DM, the group for a group. */
  readonly chatJid: Jid;
  /** Who sent it. Equal to `chatJid` in a DM. */
  readonly senderJid: Jid;
  /** Whether this message mentions the bot or replies to one of its messages. */
  readonly addressesBot: boolean;
}

export function decideAccess(config: AccessConfig, incoming: IncomingContext): AccessDecision {
  if (isGroupJid(incoming.chatJid)) {
    const group = normalizeJid(incoming.chatJid);
    if (!config.allowedGroups.has(group)) {
      return { allowed: false, reason: `group ${group} is not in WHATSAPP_ALLOWED_GROUPS` };
    }
    if (config.requireMentionInGroups && !incoming.addressesBot) {
      return { allowed: false, reason: "group message did not address the bot" };
    }
    return { allowed: true };
  }

  const sender = normalizeJid(incoming.senderJid);
  if (!config.allowedNumbers.has(sender)) {
    return { allowed: false, reason: `number ${sender} is not in WHATSAPP_ALLOWED_NUMBERS` };
  }
  return { allowed: true };
}

export function parseJidList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeJid(entry))
      .filter((entry) => entry.length > 0),
  );
}

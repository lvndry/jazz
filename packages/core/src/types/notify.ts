/**
 * Notify channels: where Jazz tells you that something happened while you were away. Each
 * named channel is one delivery target; secrets (bot tokens, webhook URLs that embed a token,
 * signing keys) live in the keyring, not in config.json. See `notify/outbox.ts` for routing.
 */

/** Events a channel can subscribe to. Workflow results go only where `deliver:` names. */
export const NOTIFY_SUBSCRIBABLE_EVENTS = [
  "reminder",
  "approval-needed",
  "unattended-failed",
  "spend-ceiling",
] as const;

export type NotifySubscribableEvent = (typeof NOTIFY_SUBSCRIBABLE_EVENTS)[number];

export type NotifyEventKind = NotifySubscribableEvent | "workflow-result";

/** A channel name: it is also the outbox's file name, so it stays a plain storage key. */
export const NOTIFY_CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const NOTIFY_CHANNEL_TYPES = ["telegram", "discord", "webhook", "desktop"] as const;

export type NotifyChannelType = (typeof NOTIFY_CHANNEL_TYPES)[number];

interface NotifyChannelCommon {
  /** What this channel receives. Unset means every subscribable event. */
  readonly events?: readonly NotifySubscribableEvent[];
}

export interface TelegramNotifyChannel extends NotifyChannelCommon {
  readonly type: "telegram";
  readonly chatId?: string;
  /** Secret: kept in the keyring. */
  readonly botToken?: string;
  /** A self-hosted Bot API server. Defaults to https://api.telegram.org. */
  readonly apiBaseUrl?: string;
  /** A running Jazz Telegram bridge serves this chat, so approval requests offer `/approve`. */
  readonly approveFromChat?: boolean;
}

export interface DiscordNotifyChannel extends NotifyChannelCommon {
  readonly type: "discord";
  /** Secret: a channel webhook URL embeds its token. */
  readonly webhookUrl?: string;
  /** With `botToken`, post as a bot into this channel instead of through a webhook. */
  readonly channelId?: string;
  /** Secret: kept in the keyring. */
  readonly botToken?: string;
  /** Defaults to https://discord.com/api/v10. */
  readonly apiBaseUrl?: string;
  /** A running Jazz Discord bridge reads this channel, so approval requests offer `/approve`. */
  readonly approveFromChat?: boolean;
}

export interface WebhookNotifyChannel extends NotifyChannelCommon {
  readonly type: "webhook";
  readonly url?: string;
  /** Secret: signs every body as `X-Jazz-Signature-256: sha256=<hex HMAC>`. */
  readonly secret?: string;
}

export interface DesktopNotifyChannel extends NotifyChannelCommon {
  readonly type: "desktop";
}

export type NotifyChannelConfig =
  TelegramNotifyChannel | DiscordNotifyChannel | WebhookNotifyChannel | DesktopNotifyChannel;

/** Channel fields that hold secrets, by channel type. */
export const NOTIFY_CHANNEL_SECRET_FIELDS: Readonly<Record<NotifyChannelType, readonly string[]>> =
  {
    telegram: ["botToken"],
    discord: ["webhookUrl", "botToken"],
    webhook: ["secret"],
    desktop: [],
  };

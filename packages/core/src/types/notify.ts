/**
 * The `notify` block: every place Jazz tells you something happened while you were away. One
 * list of targets serves the daemon (what waits on you, a pause), `jazz run`, workflows,
 * reminders and spend caps alike. Secrets (bot tokens, a Discord webhook URL, a webhook signing
 * key) are never in config.json: they live in the keyring under
 * `notify.targets.<name>.<field>`, or in `JAZZ_NOTIFY_<NAME>_<FIELD>`. See `notify/outbox.ts`.
 */

/** Events a target can subscribe to. Workflow results go only where `deliver:` names. */
export const NOTIFY_SUBSCRIBABLE_EVENTS = [
  "waiting",
  "paused",
  "reminder",
  "unattended-failed",
  "spend-cap",
] as const;

export type NotifySubscribableEvent = (typeof NOTIFY_SUBSCRIBABLE_EVENTS)[number];

export type NotifyEventKind = NotifySubscribableEvent | "workflow-result";

export const NOTIFY_TARGET_KINDS = ["desktop", "ntfy", "webhook", "telegram", "discord"] as const;

export type NotifyTargetKind = (typeof NOTIFY_TARGET_KINDS)[number];

/** A target name: also its outbox file name and its secrets' key, so a plain storage key. */
export const NOTIFY_TARGET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface NotifyTargetCommon {
  /** How `deliver:`, the outbox and the secrets refer to this target. */
  readonly name: string;
  /** What this target receives. Unset means every subscribable event. */
  readonly events?: readonly NotifySubscribableEvent[];
}

export interface DesktopNotifyTarget extends NotifyTargetCommon {
  readonly kind: "desktop";
}

export interface NtfyNotifyTarget extends NotifyTargetCommon {
  readonly kind: "ntfy";
  /** A topic URL, like https://ntfy.sh/my-private-topic. Anyone who knows it can read it. */
  readonly url: string;
}

export interface WebhookNotifyTarget extends NotifyTargetCommon {
  readonly kind: "webhook";
  /** Receives each notification as a JSON POST; signed when the target has a `secret`. */
  readonly url: string;
}

export interface TelegramNotifyTarget extends NotifyTargetCommon {
  readonly kind: "telegram";
  readonly chatId: string;
  /** A self-hosted Bot API server. Defaults to https://api.telegram.org. */
  readonly apiBaseUrl?: string;
  /** A running Jazz Telegram bridge serves this chat, so approval requests offer `/approve`. */
  readonly approveFromChat?: boolean;
}

export interface DiscordNotifyTarget extends NotifyTargetCommon {
  readonly kind: "discord";
  /** With a `botToken` secret, post as a bot into this channel instead of through a webhook. */
  readonly channelId?: string;
  /** Defaults to https://discord.com/api/v10. */
  readonly apiBaseUrl?: string;
  /** A running Jazz Discord bridge reads this channel, so approval requests offer `/approve`. */
  readonly approveFromChat?: boolean;
}

export type NotifyTarget =
  | DesktopNotifyTarget
  | NtfyNotifyTarget
  | WebhookNotifyTarget
  | TelegramNotifyTarget
  | DiscordNotifyTarget;

export interface NotifyConfig {
  /** Unset means one desktop target. An empty list sends nothing. */
  readonly targets?: readonly NotifyTarget[];
}

/** The keyring secrets each target kind reads (`notify.targets.<name>.<field>`). */
export const NOTIFY_TARGET_SECRET_FIELDS: Readonly<Record<NotifyTargetKind, readonly string[]>> = {
  desktop: [],
  ntfy: [],
  webhook: ["secret"],
  telegram: ["botToken"],
  discord: ["webhookUrl", "botToken"],
};

/**
 * @fileoverview Sending one notification to one notify channel: Telegram, Discord, a signed
 * webhook, or the desktop.
 *
 * Every send returns a `DeliveryOutcome` and never throws, so the outbox can settle it: a
 * network error, a timeout, a 429 or a 5xx is retryable; any other refusal (a wrong token, a
 * chat the bot cannot post in, a missing secret) is not, and stays visible in
 * `jazz notify outbox` with its reason. Error text never includes a URL or header, since both
 * can carry the channel's token.
 *
 * Secrets resolve in this order: the channel's environment variable
 * (`JAZZ_NOTIFY_<CHANNEL>_<FIELD>`), the value in config.json (only present when the host has
 * no keyring), then the keyring.
 */

import { createHmac } from "node:crypto";
import { type NotifyEvent, renderNotification } from "@jazz/core/notify/events";
import type { NotifyChannelConfig } from "@jazz/core/types/notify";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { sendDesktopNotification } from "@jazz/core/utils/desktop-notify";
import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/adapters/secrets/keyring";
import { notifyChannelSecretEnvVar, notifyChannelSecretPath } from "@/adapters/secrets/registry";

/** A send that has not answered in this long is abandoned and retried later. */
export const NOTIFY_SEND_TIMEOUT_MS = 15_000;

/** Telegram's `sendMessage` text limit. */
const TELEGRAM_MESSAGE_LIMIT = 4_096;

/** Discord's message `content` limit. */
const DISCORD_MESSAGE_LIMIT = 2_000;

/** A long workflow result is split into at most this many chat messages, then truncated. */
const MAX_MESSAGE_PARTS = 4;

const DEFAULT_TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_DISCORD_API = "https://discord.com/api/v10";

/** Header carrying `sha256=<hex HMAC of "<timestamp>.<body>">` on webhook deliveries. */
export const WEBHOOK_SIGNATURE_HEADER = "X-Jazz-Signature-256";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Jazz-Timestamp";
export const WEBHOOK_DELIVERY_HEADER = "X-Jazz-Delivery";
export const WEBHOOK_EVENT_HEADER = "X-Jazz-Event";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SendContext {
  /** The outbox item's id; a webhook receiver dedupes on it. */
  readonly deliveryId: string;
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: number;
}

/** A channel secret from the environment, config.json, or the keyring, in that order. */
export function resolveChannelSecret(
  channelName: string,
  field: string,
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const fromEnv = env[notifyChannelSecretEnvVar(channelName, field)]?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
    if (configured !== undefined && configured.trim().length > 0) {
      return configured.trim();
    }
    const backend = yield* detectKeyringBackend();
    const stored = yield* keyringGet(backend, notifyChannelSecretPath(channelName, field));
    return stored?.trim() || undefined;
  });
}

/** Split `text` into parts of at most `limit` characters, preferring line breaks. */
export function splitMessage(text: string, limit: number, maxParts = MAX_MESSAGE_PARTS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0 && parts.length < maxParts) {
    if (rest.length <= limit) {
      parts.push(rest);
      rest = "";
      break;
    }
    const window = rest.slice(0, limit);
    const breakAt = window.lastIndexOf("\n");
    const cut = breakAt > limit / 2 ? breakAt : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) {
    const marker = "\n\n[truncated]";
    const last = parts.pop() ?? "";
    parts.push(`${last.slice(0, Math.max(0, limit - marker.length))}${marker}`);
  }
  return parts;
}

function refused(error: string): DeliveryOutcome {
  return { delivered: false, error, retryable: false };
}

function retryLater(error: string): DeliveryOutcome {
  return { delivered: false, error, retryable: true };
}

/** 429 and 5xx are the channel's problem and worth retrying; any other refusal is ours. */
function outcomeOfStatus(channelLabel: string, status: number, detail: string): DeliveryOutcome {
  const message = `${channelLabel} answered HTTP ${status}${detail.length > 0 ? `: ${detail}` : ""}`;
  return status === 429 || status >= 500 ? retryLater(message) : refused(message);
}

/** A short, token-free reason from a refusal body (Telegram and Discord send JSON). */
async function refusalDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { description?: unknown; message?: unknown };
    const reason = parsed.description ?? parsed.message;
    return typeof reason === "string" ? reason.slice(0, 200) : "";
  } catch {
    return "";
  }
}

function post(
  context: SendContext,
  channelLabel: string,
  url: string,
  body: string,
  headers: Record<string, string>,
): Effect.Effect<DeliveryOutcome, never> {
  const fetchImpl = context.fetch ?? fetch;
  return Effect.promise(async (): Promise<DeliveryOutcome> => {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        signal: AbortSignal.timeout(NOTIFY_SEND_TIMEOUT_MS),
        redirect: "error",
      });
      if (response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { delivered: true };
      }
      return outcomeOfStatus(channelLabel, response.status, await refusalDetail(response));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return retryLater(
        name === "TimeoutError"
          ? `${channelLabel} did not answer within ${NOTIFY_SEND_TIMEOUT_MS / 1000}s`
          : `${channelLabel} could not be reached (${name || "network error"})`,
      );
    }
  });
}

/** Send parts in order, stopping at the first that is not delivered. */
function sendParts(
  parts: readonly string[],
  sendOne: (part: string) => Effect.Effect<DeliveryOutcome, never>,
): Effect.Effect<DeliveryOutcome, never> {
  return Effect.gen(function* () {
    for (const part of parts) {
      const outcome = yield* sendOne(part);
      if (!outcome.delivered) {
        return outcome;
      }
    }
    return { delivered: true } as const;
  });
}

function chatText(event: NotifyEvent, approveFromChat: boolean | undefined): string {
  const rendered = renderNotification(event, {
    ...(approveFromChat !== undefined ? { approveFromChat } : {}),
  });
  return `${rendered.title}\n\n${rendered.body}`;
}

/** Send one event to one channel. */
export function sendToChannel(
  channelName: string,
  channel: NotifyChannelConfig,
  event: NotifyEvent,
  context: SendContext,
): Effect.Effect<DeliveryOutcome, never> {
  return Effect.gen(function* () {
    const env = context.env ?? process.env;
    switch (channel.type) {
      case "desktop": {
        const rendered = renderNotification(event);
        const shown = yield* sendDesktopNotification(rendered.title, rendered.body);
        return shown
          ? ({ delivered: true } as const)
          : retryLater("No desktop notification could be shown on this host.");
      }
      case "telegram": {
        const token = yield* resolveChannelSecret(channelName, "botToken", channel.botToken, env);
        if (token === undefined) {
          return refused(
            `No bot token for "${channelName}": set it with \`jazz config set ${notifyChannelSecretPath(channelName, "botToken")}\`.`,
          );
        }
        if (channel.chatId === undefined) {
          return refused(`"${channelName}" has no chatId.`);
        }
        const url = `${channel.apiBaseUrl ?? DEFAULT_TELEGRAM_API}/bot${token}/sendMessage`;
        return yield* sendParts(
          splitMessage(chatText(event, channel.approveFromChat), TELEGRAM_MESSAGE_LIMIT),
          (part) =>
            post(
              context,
              "Telegram",
              url,
              JSON.stringify({
                chat_id: channel.chatId,
                text: part,
                link_preview_options: { is_disabled: true },
              }),
              {},
            ),
        );
      }
      case "discord": {
        const text = splitMessage(chatText(event, channel.approveFromChat), DISCORD_MESSAGE_LIMIT);
        const botToken = yield* resolveChannelSecret(
          channelName,
          "botToken",
          channel.botToken,
          env,
        );
        if (botToken !== undefined && channel.channelId !== undefined) {
          const url = `${channel.apiBaseUrl ?? DEFAULT_DISCORD_API}/channels/${channel.channelId}/messages`;
          return yield* sendParts(text, (part) =>
            post(
              context,
              "Discord",
              url,
              JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
              { authorization: `Bot ${botToken}` },
            ),
          );
        }
        const webhookUrl = yield* resolveChannelSecret(
          channelName,
          "webhookUrl",
          channel.webhookUrl,
          env,
        );
        if (webhookUrl === undefined) {
          return refused(
            `"${channelName}" needs a webhookUrl, or a botToken with a channelId: set it with \`jazz config set ${notifyChannelSecretPath(channelName, "webhookUrl")}\`.`,
          );
        }
        return yield* sendParts(text, (part) =>
          post(
            context,
            "Discord",
            webhookUrl,
            JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
            {},
          ),
        );
      }
      case "webhook": {
        if (channel.url === undefined) {
          return refused(`"${channelName}" has no url.`);
        }
        const secret = yield* resolveChannelSecret(channelName, "secret", channel.secret, env);
        if (secret === undefined) {
          return refused(
            `"${channelName}" has no signing secret: set it with \`jazz config set ${notifyChannelSecretPath(channelName, "secret")}\`.`,
          );
        }
        const rendered = renderNotification(event);
        const timestamp = String(Math.floor((context.now ?? Date.now()) / 1000));
        const body = JSON.stringify({
          id: context.deliveryId,
          type: event.kind,
          title: rendered.title,
          text: rendered.body,
          event,
        });
        return yield* post(context, "The webhook", channel.url, body, {
          [WEBHOOK_EVENT_HEADER]: event.kind,
          [WEBHOOK_DELIVERY_HEADER]: context.deliveryId,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, timestamp, body),
        });
      }
    }
  });
}

/**
 * `sha256=<hex>` over `"<timestamp>.<body>"`. A receiver recomputes it with the shared secret,
 * compares in constant time, and rejects timestamps far from its own clock.
 */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

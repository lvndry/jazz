/**
 * @fileoverview Sending one notification to one `notify` target: the desktop, an ntfy topic, a
 * webhook (HMAC-signed when it has a secret), Telegram, or Discord.
 *
 * Every send returns a `DeliveryOutcome` and never throws, so the outbox can settle it: a
 * network error, a timeout, a 429 or a 5xx is retryable; any other refusal (a wrong token, a
 * chat the bot cannot post in, a missing secret, a host with no desktop session) is not, and
 * stays visible in `jazz notify outbox` with its reason. Error text never includes a URL or
 * header, since both can carry the target's token.
 *
 * Secrets come from the target's environment variable (`JAZZ_NOTIFY_<NAME>_<FIELD>`), then the
 * keyring (`notify.targets.<name>.<field>`); config.json never holds them.
 */

import { createHmac } from "node:crypto";
import { type NotifyEvent, renderNotification } from "@jazz/core/notify/events";
import { notifyTargetSecretEnvVar, notifyTargetSecretPath } from "@jazz/core/secrets/registry";
import type { NotifyTarget } from "@jazz/core/types/notify";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { Effect } from "effect";
import { detectKeyringBackend, keyringGet } from "@/adapters/secrets/keyring";
import { sendDesktopNotification } from "./desktop-notifier";

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

/** Reads one keyring entry by its config path. */
export type KeyringReader = (secretPath: string) => Effect.Effect<string | undefined, never>;

export interface SendContext {
  /** The outbox item's id; a webhook receiver dedupes on it. */
  readonly deliveryId: string;
  readonly fetch?: FetchLike;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: number;
  readonly readKeyring?: KeyringReader;
}

const readSystemKeyring: KeyringReader = (secretPath) =>
  Effect.flatMap(detectKeyringBackend(), (backend) => keyringGet(backend, secretPath));

/** A target's secret from its environment variable, then the keyring. */
export function resolveTargetSecret(
  targetName: string,
  field: string,
  env: NodeJS.ProcessEnv = process.env,
  readKeyring: KeyringReader = readSystemKeyring,
): Effect.Effect<string | undefined, never> {
  return Effect.gen(function* () {
    const fromEnv = env[notifyTargetSecretEnvVar(targetName, field)]?.trim();
    if (fromEnv !== undefined && fromEnv.length > 0) {
      return fromEnv;
    }
    const stored = yield* readKeyring(notifyTargetSecretPath(targetName, field));
    return stored?.trim() || undefined;
  });
}

function secretHint(targetName: string, field: string): string {
  return `set it with \`jazz config set ${notifyTargetSecretPath(targetName, field)}\` (kept in the keyring) or ${notifyTargetSecretEnvVar(targetName, field)}`;
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

/** 429 and 5xx are the service's problem and worth retrying; any other refusal is ours. */
function outcomeOfStatus(serviceLabel: string, status: number, detail: string): DeliveryOutcome {
  const message = `${serviceLabel} answered HTTP ${status}${detail.length > 0 ? `: ${detail}` : ""}`;
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
  serviceLabel: string,
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
      return outcomeOfStatus(serviceLabel, response.status, await refusalDetail(response));
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      return retryLater(
        name === "TimeoutError"
          ? `${serviceLabel} did not answer within ${NOTIFY_SEND_TIMEOUT_MS / 1000}s`
          : `${serviceLabel} could not be reached (${name || "network error"})`,
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

/**
 * The JSON body every webhook target receives: the delivery id (the same on a retry), the event
 * kind, the rendered text, and the event itself.
 */
export function webhookBody(deliveryId: string, event: NotifyEvent): string {
  const rendered = renderNotification(event);
  return JSON.stringify({
    id: deliveryId,
    type: event.kind,
    title: rendered.title,
    body: rendered.body,
    event,
  });
}

/** Send one event to one target. */
export function sendToTarget(
  target: NotifyTarget,
  event: NotifyEvent,
  context: SendContext,
): Effect.Effect<DeliveryOutcome, never> {
  return Effect.gen(function* () {
    const env = context.env ?? process.env;
    const readKeyring = context.readKeyring ?? readSystemKeyring;
    const secretOf = (field: string) => resolveTargetSecret(target.name, field, env, readKeyring);
    const name = target.name;
    switch (target.kind) {
      case "desktop": {
        const rendered = renderNotification(event);
        return yield* sendDesktopNotification({ title: rendered.title, message: rendered.body });
      }
      case "ntfy": {
        const rendered = renderNotification(event);
        return yield* post(context, "ntfy", target.url, rendered.body, {
          "content-type": "text/plain; charset=utf-8",
          Title: rendered.title,
          Tags: "jazz",
        });
      }
      case "webhook": {
        const secret = yield* secretOf("secret");
        const body = webhookBody(context.deliveryId, event);
        const timestamp = String(Math.floor((context.now ?? Date.now()) / 1000));
        return yield* post(context, "The webhook", target.url, body, {
          [WEBHOOK_EVENT_HEADER]: event.kind,
          [WEBHOOK_DELIVERY_HEADER]: context.deliveryId,
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          ...(secret !== undefined
            ? { [WEBHOOK_SIGNATURE_HEADER]: signWebhookBody(secret, timestamp, body) }
            : {}),
        });
      }
      case "telegram": {
        const token = yield* secretOf("botToken");
        if (token === undefined) {
          return refused(`No bot token for "${name}": ${secretHint(name, "botToken")}.`);
        }
        const url = `${target.apiBaseUrl ?? DEFAULT_TELEGRAM_API}/bot${token}/sendMessage`;
        return yield* sendParts(
          splitMessage(chatText(event, target.approveFromChat), TELEGRAM_MESSAGE_LIMIT),
          (part) =>
            post(
              context,
              "Telegram",
              url,
              JSON.stringify({
                chat_id: target.chatId,
                text: part,
                link_preview_options: { is_disabled: true },
              }),
              {},
            ),
        );
      }
      case "discord": {
        const text = splitMessage(chatText(event, target.approveFromChat), DISCORD_MESSAGE_LIMIT);
        const botToken = yield* secretOf("botToken");
        if (botToken !== undefined && target.channelId !== undefined) {
          const url = `${target.apiBaseUrl ?? DEFAULT_DISCORD_API}/channels/${target.channelId}/messages`;
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
        const webhookUrl = yield* secretOf("webhookUrl");
        if (webhookUrl === undefined) {
          return refused(
            `"${name}" needs a webhookUrl, or a botToken with a channelId: ${secretHint(name, "webhookUrl")}.`,
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

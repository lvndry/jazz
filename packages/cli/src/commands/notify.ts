/**
 * `jazz notify`: see the configured notify channels, send a test through one, and inspect or
 * retry what is waiting in the outbox. Channels themselves are configured under
 * `notifications.channels` (see docs/configure/notifications.md).
 */

import { sendToChannel } from "@jazz/adapters/notification/channels";
import {
  drainNotifyOutbox,
  listOutbox,
  retryStoppedNotifications,
} from "@jazz/adapters/notification/outbox-drain";
import { notifyChannelSecretEnvVar } from "@jazz/adapters/secrets/registry";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import {
  NOTIFY_CHANNEL_NAME_PATTERN,
  NOTIFY_CHANNEL_TYPES,
  NOTIFY_SUBSCRIBABLE_EVENTS,
  type NotifyChannelConfig,
  type NotifyChannelType,
  type NotifySubscribableEvent,
} from "@jazz/core/types/notify";
import { checkConfigWrite } from "@jazz/core/utils/config-schema";
import { Effect } from "effect";
import { emitEnvelope, failEnvelope } from "../helpers/json-output";

export function listNotifyChannelsCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const channels = Object.entries(appConfig.notifications?.channels ?? {}).map(
      ([name, channel]) => ({
        name,
        type: channel.type,
        events: channel.events === undefined ? "all" : channel.events.join(", "),
        ...("approveFromChat" in channel && channel.approveFromChat === true
          ? { approveFromChat: true }
          : {}),
      }),
    );
    const text =
      channels.length === 0
        ? "No notify channels configured. Add one with `jazz notify add <name> --type telegram|discord|webhook|desktop`."
        : channels
            .map((channel) => `${channel.name}  ${channel.type}  events: ${channel.events}`)
            .join("\n");
    emitEnvelope(options.json, { ok: true, channels }, text);
  });
}

/** Send one test message through a channel, directly, and report what the channel said. */
export function testNotifyChannelCommand(options: {
  readonly channel: string;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const channel = appConfig.notifications?.channels?.[options.channel];
    if (channel === undefined) {
      failEnvelope(options.json, `No notify channel named "${options.channel}".`);
      return;
    }
    const outcome = yield* sendToChannel(
      options.channel,
      channel,
      {
        kind: "unattended-failed",
        source: "run",
        name: "notify test",
        error: "This is a test from `jazz notify test`. If you can read it, the channel works.",
      },
      { deliveryId: `test-${Date.now().toString(36)}` },
    );
    if (!outcome.delivered) {
      failEnvelope(options.json, `"${options.channel}" did not accept the test: ${outcome.error}`);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, channel: options.channel },
      `Sent a test through "${options.channel}".`,
    );
  });
}

export function notifyOutboxCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const entries = yield* listOutbox();
    const text =
      entries.length === 0
        ? "The notify outbox is empty: everything queued was delivered."
        : entries
            .map((entry) => {
              const why =
                entry.delivery.lastError === undefined ? "" : `  ${entry.delivery.lastError}`;
              const next =
                entry.delivery.nextAttemptAt === undefined
                  ? ""
                  : `  next try ${entry.delivery.nextAttemptAt}`;
              return `${entry.queuedAt}  ${entry.channel}  ${entry.kind}  ${entry.delivery.status}${next}${why}`;
            })
            .join("\n");
    emitEnvelope(options.json, { ok: true, notifications: entries }, text);
  });
}

/** Re-arm notifications that stopped retrying, then try the whole outbox once now. */
export function retryNotifyOutboxCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const rearmed = yield* retryStoppedNotifications();
    const report = yield* drainNotifyOutbox();
    emitEnvelope(
      options.json,
      { ok: report.failed === 0, rearmed, ...report },
      `Re-armed ${rearmed}; delivered ${report.delivered}, failed ${report.failed}.`,
    );
    if (report.failed > 0) {
      process.exitCode = 1;
    }
  });
}

export interface AddNotifyChannelOptions {
  readonly name: string;
  readonly type: string;
  readonly chatId?: string;
  readonly channelId?: string;
  readonly url?: string;
  readonly apiBaseUrl?: string;
  readonly events?: string;
  readonly approveFromChat?: boolean;
}

/** The secret a channel type needs, and the prompt that asks for it. */
const CHANNEL_SECRET_PROMPTS: Readonly<
  Record<NotifyChannelType, { readonly field: string; readonly prompt: string } | undefined>
> = {
  telegram: { field: "botToken", prompt: "Telegram bot token (from @BotFather):" },
  discord: {
    field: "webhookUrl",
    prompt: "Discord webhook URL (Channel settings > Integrations > Webhooks):",
  },
  webhook: { field: "secret", prompt: "Signing secret shared with the receiver:" },
  desktop: undefined,
};

function isChannelType(value: string): value is NotifyChannelType {
  return (NOTIFY_CHANNEL_TYPES as readonly string[]).includes(value);
}

function parseEvents(raw: string | undefined): readonly NotifySubscribableEvent[] | string {
  if (raw === undefined) {
    return [];
  }
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter(
    (name) => !(NOTIFY_SUBSCRIBABLE_EVENTS as readonly string[]).includes(name),
  );
  return unknown.length > 0
    ? `Unknown event ${unknown.join(", ")}. Pass any of: ${NOTIFY_SUBSCRIBABLE_EVENTS.join(", ")}.`
    : (names as NotifySubscribableEvent[]);
}

function channelConfig(
  options: AddNotifyChannelOptions,
  type: NotifyChannelType,
  events: readonly NotifySubscribableEvent[],
): NotifyChannelConfig {
  const common = events.length > 0 ? { events } : {};
  switch (type) {
    case "telegram":
      return {
        type,
        ...common,
        ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.approveFromChat === true ? { approveFromChat: true } : {}),
      };
    case "discord":
      return {
        type,
        ...common,
        ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
        ...(options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {}),
        ...(options.approveFromChat === true ? { approveFromChat: true } : {}),
      };
    case "webhook":
      return { type, ...common, ...(options.url !== undefined ? { url: options.url } : {}) };
    case "desktop":
      return { type, ...common };
  }
}

/**
 * Add (or replace) a notify channel, then ask for its secret on a terminal. Without a terminal
 * the command says which key to set instead, so the secret never has to pass through argv.
 */
export function addNotifyChannelCommand(options: AddNotifyChannelOptions) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    if (!NOTIFY_CHANNEL_NAME_PATTERN.test(options.name)) {
      failEnvelope(false, "A channel name is lowercase letters, digits, - and _ (e.g. phone).");
      return;
    }
    if (!isChannelType(options.type)) {
      failEnvelope(
        false,
        `Unknown channel type "${options.type}". Pass ${NOTIFY_CHANNEL_TYPES.join(", ")}.`,
      );
      return;
    }
    const events = parseEvents(options.events);
    if (typeof events === "string") {
      failEnvelope(false, events);
      return;
    }
    if (options.type === "telegram" && options.chatId === undefined) {
      failEnvelope(
        false,
        "A telegram channel needs --chat-id (message the bot, then read it from getUpdates).",
      );
      return;
    }
    if (options.type === "webhook" && options.url === undefined) {
      failEnvelope(false, "A webhook channel needs --url.");
      return;
    }
    const check = checkConfigWrite(
      `notifications.channels.${options.name}`,
      channelConfig(options, options.type, events),
    );
    if (!check.ok) {
      failEnvelope(false, `Refusing to write that channel: ${check.problem}`);
      return;
    }
    yield* configService.set(
      `notifications.channels.${options.name}`,
      channelConfig(options, options.type, events),
    );
    yield* terminal.success(`Notify channel "${options.name}" (${options.type}) saved.`);

    const secret = CHANNEL_SECRET_PROMPTS[options.type];
    const secretKey =
      secret === undefined ? undefined : `notifications.channels.${options.name}.${secret.field}`;
    if (secret !== undefined && secretKey !== undefined) {
      const value = process.stdin.isTTY
        ? yield* terminal.ask(secret.prompt, { simple: true, secret: true, cancellable: true })
        : undefined;
      if (value === undefined || value.trim().length === 0) {
        yield* terminal.info(
          `Set its ${secret.field} with \`jazz config set ${secretKey}\` (kept in the keyring), or export ${notifyChannelSecretEnvVar(options.name, secret.field)}.`,
        );
      } else {
        yield* configService.set(secretKey, value.trim());
        if (configService.secretStorageUnavailable(secretKey)) {
          failEnvelope(false, `The ${secret.field} could not be stored: no keyring is available.`);
          return;
        }
        yield* terminal.success(`${secret.field} stored in the keyring.`);
      }
    }
    yield* terminal.info(`Check it with \`jazz notify test ${options.name}\`.`);
  });
}

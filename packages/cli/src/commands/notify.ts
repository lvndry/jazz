/**
 * `jazz notify`: list the `notify.targets`, add or replace one, send a test through one, and
 * inspect or retry what is waiting in the outbox (see docs/configure/notifications.md).
 */

import {
  drainNotifyOutbox,
  listOutbox,
  retryStoppedNotifications,
} from "@jazz/adapters/notification/outbox-drain";
import { sendToTarget } from "@jazz/adapters/notification/targets";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { notifyTargets } from "@jazz/core/notify/outbox";
import { notifyTargetSecretEnvVar, notifyTargetSecretPath } from "@jazz/core/secrets/registry";
import {
  NOTIFY_SUBSCRIBABLE_EVENTS,
  NOTIFY_TARGET_KINDS,
  NOTIFY_TARGET_NAME_PATTERN,
  type NotifySubscribableEvent,
  type NotifyTarget,
  type NotifyTargetKind,
} from "@jazz/core/types/notify";
import { checkConfigWrite } from "@jazz/core/utils/config-schema";
import { Effect } from "effect";
import { emitEnvelope, failEnvelope } from "../helpers/json-output";

function describeTarget(target: NotifyTarget): string {
  const events = target.events === undefined ? "all events" : target.events.join(", ");
  const where =
    target.kind === "ntfy" || target.kind === "webhook"
      ? `  ${target.url}`
      : target.kind === "telegram"
        ? `  chat ${target.chatId}`
        : "";
  return `${target.name}  ${target.kind}${where}  (${events})`;
}

export function listNotifyTargetsCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const targets = notifyTargets(appConfig);
    const implicit = appConfig.notify?.targets === undefined;
    const text =
      targets.length === 0
        ? "No notify targets: nothing is sent. Add one with `jazz notify add <name> --kind <kind>`."
        : [
            ...targets.map(describeTarget),
            ...(implicit ? ["(the default: notify.targets is unset)"] : []),
          ].join("\n");
    emitEnvelope(options.json, { ok: true, targets, implicit }, text);
  });
}

/** Send one test message through a target, directly, and report what the target said. */
export function testNotifyTargetCommand(options: {
  readonly target: string;
  readonly json: boolean;
}) {
  return Effect.gen(function* () {
    const appConfig = yield* (yield* AgentConfigServiceTag).appConfig;
    const target = notifyTargets(appConfig).find((candidate) => candidate.name === options.target);
    if (target === undefined) {
      failEnvelope(options.json, `No notify target named "${options.target}".`);
      return;
    }
    const outcome = yield* sendToTarget(
      target,
      {
        kind: "unattended-failed",
        source: "run",
        name: "notify test",
        error: "This is a test from `jazz notify test`. If you can read it, the target works.",
      },
      { deliveryId: `test-${Date.now().toString(36)}` },
    );
    if (!outcome.delivered) {
      failEnvelope(options.json, `"${options.target}" did not accept the test: ${outcome.error}`);
      return;
    }
    emitEnvelope(
      options.json,
      { ok: true, target: options.target },
      `Sent a test through "${options.target}".`,
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
              return `${entry.queuedAt}  ${entry.target}  ${entry.kind}  ${entry.delivery.status}${next}${why}`;
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

export interface AddNotifyTargetOptions {
  readonly name: string;
  readonly kind: string;
  readonly chatId?: string;
  readonly channelId?: string;
  readonly url?: string;
  readonly apiBaseUrl?: string;
  readonly events?: string;
  readonly approveFromChat?: boolean;
}

/** The secret a target kind asks for on a terminal, if any. */
const TARGET_SECRET_PROMPTS: Readonly<
  Record<NotifyTargetKind, { readonly field: string; readonly prompt: string } | undefined>
> = {
  desktop: undefined,
  ntfy: undefined,
  webhook: {
    field: "secret",
    prompt: "Signing secret shared with the receiver (empty to send unsigned):",
  },
  telegram: { field: "botToken", prompt: "Telegram bot token (from @BotFather):" },
  discord: {
    field: "webhookUrl",
    prompt: "Discord webhook URL (Channel settings > Integrations > Webhooks):",
  },
};

function isTargetKind(value: string): value is NotifyTargetKind {
  return (NOTIFY_TARGET_KINDS as readonly string[]).includes(value);
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

/** The target the flags describe, or why they do not describe one. */
export function targetFromOptions(options: AddNotifyTargetOptions): NotifyTarget | string {
  if (!NOTIFY_TARGET_NAME_PATTERN.test(options.name)) {
    return "A target name is lowercase letters, digits, - and _ (e.g. phone).";
  }
  if (!isTargetKind(options.kind)) {
    return `Unknown target kind "${options.kind}". Pass ${NOTIFY_TARGET_KINDS.join(", ")}.`;
  }
  const events = parseEvents(options.events);
  if (typeof events === "string") {
    return events;
  }
  const common = { name: options.name, ...(events.length > 0 ? { events } : {}) };
  const approve = options.approveFromChat === true ? { approveFromChat: true } : {};
  const apiBaseUrl = options.apiBaseUrl !== undefined ? { apiBaseUrl: options.apiBaseUrl } : {};
  switch (options.kind) {
    case "desktop":
      return { ...common, kind: "desktop" };
    case "ntfy":
    case "webhook":
      return options.url === undefined
        ? `A ${options.kind} target needs --url.`
        : { ...common, kind: options.kind, url: options.url };
    case "telegram":
      return options.chatId === undefined
        ? "A telegram target needs --chat-id (message the bot, then read it from getUpdates)."
        : { ...common, kind: "telegram", chatId: options.chatId, ...apiBaseUrl, ...approve };
    case "discord":
      return {
        ...common,
        kind: "discord",
        ...(options.channelId !== undefined ? { channelId: options.channelId } : {}),
        ...apiBaseUrl,
        ...approve,
      };
  }
}

/**
 * Add (or replace, by name) a notify target, then ask for its secret on a terminal. Without a
 * terminal the command says which key to set instead, so the secret never passes through argv.
 */
export function addNotifyTargetCommand(options: AddNotifyTargetOptions) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const target = targetFromOptions(options);
    if (typeof target === "string") {
      failEnvelope(false, target);
      return;
    }
    const appConfig = yield* configService.appConfig;
    const targets = [
      ...(appConfig.notify?.targets ?? []).filter((existing) => existing.name !== target.name),
      target,
    ];
    const check = checkConfigWrite("notify.targets", targets);
    if (!check.ok) {
      failEnvelope(false, `Refusing to write that target: ${check.problem}`);
      return;
    }
    yield* configService.set("notify.targets", targets);
    yield* terminal.success(`Notify target "${target.name}" (${target.kind}) saved.`);
    if (appConfig.notify?.targets === undefined && target.kind !== "desktop") {
      yield* terminal.info(
        "notify.targets is now set, so the default desktop target is gone: add it back with `jazz notify add desktop --kind desktop` to keep desktop notifications.",
      );
    }

    const secret = TARGET_SECRET_PROMPTS[target.kind];
    if (secret !== undefined) {
      const secretKey = notifyTargetSecretPath(target.name, secret.field);
      const value = process.stdin.isTTY
        ? yield* terminal.ask(secret.prompt, { simple: true, secret: true, cancellable: true })
        : undefined;
      if (value === undefined || value.trim().length === 0) {
        yield* terminal.info(
          `Set its ${secret.field} with \`jazz config set ${secretKey}\` (kept in the keyring), or export ${notifyTargetSecretEnvVar(target.name, secret.field)}.`,
        );
      } else {
        yield* configService.set(secretKey, value.trim());
        if (configService.secretStorageUnavailable(secretKey)) {
          failEnvelope(
            false,
            `The ${secret.field} could not be stored: no keyring is available. Export ${notifyTargetSecretEnvVar(target.name, secret.field)} instead.`,
          );
          return;
        }
        yield* terminal.success(`${secret.field} stored in the keyring.`);
      }
    }
    yield* terminal.info(`Check it with \`jazz notify test ${target.name}\`.`);
  });
}

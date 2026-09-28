/**
 * @fileoverview The one desktop notification sender. Every desktop notification Jazz shows (an
 * agent finishing, a reminder, a `desktop` notify target) goes through
 * {@link sendDesktopNotification}, over one of two channels:
 *
 * - the terminal: when the process has a controlling terminal and that terminal shows
 *   notifications itself (see `@jazz/core/notify/terminal-notification`), the notification is an
 *   escape sequence written to `/dev/tty`. It is reported delivered once the write succeeded;
 *   terminals send no acknowledgement.
 * - the OS notifier otherwise: `terminal-notifier` on macOS and `notify-send` on Linux. On macOS
 *   the binary is the one bundled with the release (`vendor/terminal-notifier`), an override in
 *   `JAZZ_TERMINAL_NOTIFIER`, or one on PATH or in Homebrew. It is reported delivered only when
 *   the notifier started and did not exit with an error.
 *
 * A notification is shown on one channel only: the OS notifier is used when no escape sequence
 * was written. A host with neither channel gets a non-retryable failure naming what to install.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import {
  encodeTerminalNotification,
  resolveTerminalNotificationSetting,
  selectTerminalNotificationProtocol,
  type TerminalNotificationProtocol,
} from "@jazz/core/notify/terminal-notification";
import type { TerminalNotificationSetting } from "@jazz/core/types/config";
import {
  canWriteControllingTerminal,
  writeControllingTerminal,
} from "@jazz/core/utils/controlling-terminal";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { Effect, Option } from "effect";
import { getTerminalBundleId } from "./terminal-bundle-id";
import { findExecutableOnPath, resolveTerminalNotifierBinary } from "./terminal-notifier-path";

/**
 * How long a launched notifier may take to fail. `terminal-notifier -activate` stays alive until
 * the notification is clicked, so a notifier still running after this long has shown it.
 */
export const NOTIFIER_EXIT_GRACE_MS = 1_500;

export const TERMINAL_NOTIFIER_MISSING =
  "terminal-notifier not found — install it with `brew install terminal-notifier` or use the release binary";

export const NOTIFY_SEND_MISSING =
  "notify-send not found — install libnotify (`libnotify-bin` on Debian and Ubuntu, `libnotify` elsewhere)";

export const NO_DESKTOP_SESSION =
  "No desktop session on this host: DISPLAY, WAYLAND_DISPLAY and DBUS_SESSION_BUS_ADDRESS are all unset";

export const UNSUPPORTED_DESKTOP_PLATFORM =
  "Desktop notifications are shown on macOS and Linux only";

const LINUX_SESSION_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"] as const;

const MACOS_NOTIFICATION_SOUND = "Blow";

export interface DesktopNotification {
  readonly title: string;
  readonly message: string;
  readonly subtitle?: string;
  readonly sound?: boolean;
}

/** What the sender needs to know about the host; injected in tests. */
export interface DesktopNotifierHost {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly resolveTerminalNotifier: () => string | null;
  readonly findNotifySend: () => string | null;
  /** `notifications.terminal`; `JAZZ_NOTIFICATIONS_TERMINAL` in `env` wins over it. */
  readonly terminalSetting?: TerminalNotificationSetting;
  readonly canWriteTerminal: () => boolean;
  /** Writes to the controlling terminal and says whether the bytes reached it. */
  readonly writeTerminal: (data: string) => boolean;
}

export type DesktopNotificationChannel =
  | { readonly kind: "terminal"; readonly protocol: TerminalNotificationProtocol }
  | { readonly kind: "os" };

export type LaunchOutcome =
  { readonly launched: true } | { readonly launched: false; readonly error: string };

export type LaunchNotifier = (command: string, args: readonly string[]) => Promise<LaunchOutcome>;

export type DesktopNotifierCommand =
  | { readonly available: true; readonly command: string; readonly args: readonly string[] }
  | { readonly available: false; readonly reason: string };

export function currentDesktopNotifierHost(
  terminalSetting?: TerminalNotificationSetting,
): DesktopNotifierHost {
  return {
    platform: process.platform,
    env: process.env,
    resolveTerminalNotifier: resolveTerminalNotifierBinary,
    findNotifySend: () => findExecutableOnPath("notify-send"),
    ...(terminalSetting !== undefined ? { terminalSetting } : {}),
    canWriteTerminal: canWriteControllingTerminal,
    writeTerminal: writeControllingTerminal,
  };
}

/** This host, with `notifications.terminal` from the config when a config service is provided. */
export function configuredDesktopNotifierHost(): Effect.Effect<DesktopNotifierHost, never> {
  return Effect.gen(function* () {
    const configService = yield* Effect.serviceOption(AgentConfigServiceTag);
    if (Option.isNone(configService)) {
      return currentDesktopNotifierHost();
    }
    const appConfig = yield* configService.value.appConfig;
    return currentDesktopNotifierHost(appConfig.notifications?.terminal);
  });
}

/**
 * The terminal when a sequence is selected for it and this process can write its controlling
 * terminal; the OS notifier otherwise. A daemon or scheduled job has no controlling terminal, so
 * it always uses the OS notifier, whatever `TERM_PROGRAM` it inherited.
 */
export function desktopNotificationChannel(host: DesktopNotifierHost): DesktopNotificationChannel {
  const setting = resolveTerminalNotificationSetting(host.env, host.terminalSetting);
  const protocol = selectTerminalNotificationProtocol(host.env, setting);
  if (protocol !== undefined && host.canWriteTerminal()) {
    return { kind: "terminal", protocol };
  }
  return { kind: "os" };
}

function titleWithSubtitle(notification: DesktopNotification): string {
  return notification.subtitle !== undefined && notification.subtitle.length > 0
    ? `${notification.title}: ${notification.subtitle}`
    : notification.title;
}

/**
 * Launch a notifier without letting it hold the process open, and report whether it started.
 * The child is unref'd with its stdio ignored, so a notifier that lingers (terminal-notifier
 * waiting for a click) never keeps a headless run alive. The returned promise settles when the
 * notifier exits, fails to start, or is still running after `graceMs`.
 */
export function launchDetached(
  command: string,
  args: readonly string[],
  graceMs: number = NOTIFIER_EXIT_GRACE_MS,
): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: LaunchOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(graceTimer);
      resolve(outcome);
    };
    const graceTimer = setTimeout(() => settle({ launched: true }), graceMs);
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", (error) =>
      settle({ launched: false, error: `${command} could not be launched: ${error.message}` }),
    );
    child.once("exit", (code, signal) => {
      if (code === 0 || signal !== null) {
        settle({ launched: true });
        return;
      }
      settle({ launched: false, error: `${command} exited with code ${code}` });
    });
    child.unref();
  });
}

/** The OS notifier command that shows `notification` on this host, or why none can. */
export function desktopNotifierCommand(
  notification: DesktopNotification,
  host: DesktopNotifierHost = currentDesktopNotifierHost(),
): DesktopNotifierCommand {
  if (host.platform === "darwin") {
    const terminalNotifier = host.resolveTerminalNotifier();
    if (terminalNotifier === null) {
      return { available: false, reason: TERMINAL_NOTIFIER_MISSING };
    }
    const args = ["-title", notification.title, "-message", notification.message];
    const bundleId = getTerminalBundleId();
    if (bundleId !== undefined) {
      args.push("-activate", bundleId);
    }
    if (notification.subtitle !== undefined && notification.subtitle.length > 0) {
      args.push("-subtitle", notification.subtitle);
    }
    if (notification.sound === true) {
      args.push("-sound", MACOS_NOTIFICATION_SOUND);
    }
    return { available: true, command: terminalNotifier, args };
  }
  if (host.platform === "linux") {
    const notifySend = host.findNotifySend();
    if (notifySend === null) {
      return { available: false, reason: NOTIFY_SEND_MISSING };
    }
    const hasSession = LINUX_SESSION_VARIABLES.some(
      (variable) => (host.env[variable] ?? "").length > 0,
    );
    if (!hasSession) {
      return { available: false, reason: NO_DESKTOP_SESSION };
    }
    return {
      available: true,
      command: notifySend,
      args: [titleWithSubtitle(notification), notification.message],
    };
  }
  return { available: false, reason: UNSUPPORTED_DESKTOP_PLATFORM };
}

/** Why this host can show a desktop notification on neither channel, or undefined when it can. */
export function desktopNotifierUnavailableReason(
  host: DesktopNotifierHost = currentDesktopNotifierHost(),
): string | undefined {
  if (desktopNotificationChannel(host).kind === "terminal") {
    return undefined;
  }
  const command = desktopNotifierCommand({ title: "", message: "" }, host);
  return command.available ? undefined : command.reason;
}

/** Whether this host can show a desktop notification, in its terminal or with an OS notifier. */
export function isDesktopNotifierAvailable(
  host: DesktopNotifierHost = currentDesktopNotifierHost(),
): boolean {
  return desktopNotifierUnavailableReason(host) === undefined;
}

function sendThroughOsNotifier(
  notification: DesktopNotification,
  host: DesktopNotifierHost,
  launch: LaunchNotifier,
): Effect.Effect<DeliveryOutcome, never> {
  return Effect.promise(async (): Promise<DeliveryOutcome> => {
    const command = desktopNotifierCommand(notification, host);
    if (!command.available) {
      return { delivered: false, error: command.reason, retryable: false };
    }
    const outcome = await launch(command.command, command.args).catch(
      (error: unknown): LaunchOutcome => ({
        launched: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return outcome.launched
      ? { delivered: true }
      : { delivered: false, error: outcome.error, retryable: false };
  });
}

/**
 * Show a desktop notification on one channel. In the terminal it is delivered once the escape
 * sequence was written; a write that fails falls back to the OS notifier. Through the OS notifier
 * it is delivered only when the notifier started and did not exit with an error; a missing
 * notifier, a host without a desktop session, or a notifier that fails is a non-retryable
 * failure whose error says what to install or check. Without `host`, the current host with
 * `notifications.terminal` from the config is used.
 */
export function sendDesktopNotification(
  notification: DesktopNotification,
  host?: DesktopNotifierHost,
  launch: LaunchNotifier = launchDetached,
): Effect.Effect<DeliveryOutcome, never> {
  return Effect.gen(function* () {
    const resolvedHost = host ?? (yield* configuredDesktopNotifierHost());
    const channel = desktopNotificationChannel(resolvedHost);
    if (channel.kind === "terminal") {
      const sequence = encodeTerminalNotification(
        { title: titleWithSubtitle(notification), body: notification.message },
        channel.protocol,
        { id: randomUUID(), env: resolvedHost.env },
      );
      if (resolvedHost.writeTerminal(sequence)) {
        return { delivered: true } as const;
      }
    }
    return yield* sendThroughOsNotifier(notification, resolvedHost, launch);
  });
}

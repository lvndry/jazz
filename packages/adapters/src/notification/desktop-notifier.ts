/**
 * @fileoverview The one native desktop notification sender: `terminal-notifier` on macOS and
 * `notify-send` on Linux. Every desktop notification Jazz shows (an agent finishing, a reminder,
 * a `desktop` notify target) goes through {@link sendDesktopNotification}.
 *
 * On macOS the binary is the one bundled with the release (`vendor/terminal-notifier`), an
 * override in `JAZZ_TERMINAL_NOTIFIER`, or one on PATH or in Homebrew. A host without a notifier
 * gets a non-retryable failure naming what to install; a send is reported delivered only when
 * the notifier actually started and did not exit with an error.
 */

import { spawn } from "node:child_process";
import type { DeliveryOutcome } from "@jazz/core/utils/delivery";
import { Effect } from "effect";
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
}

export type LaunchOutcome =
  { readonly launched: true } | { readonly launched: false; readonly error: string };

export type LaunchNotifier = (command: string, args: readonly string[]) => Promise<LaunchOutcome>;

export type DesktopNotifierCommand =
  | { readonly available: true; readonly command: string; readonly args: readonly string[] }
  | { readonly available: false; readonly reason: string };

export function currentDesktopNotifierHost(): DesktopNotifierHost {
  return {
    platform: process.platform,
    env: process.env,
    resolveTerminalNotifier: resolveTerminalNotifierBinary,
    findNotifySend: () => findExecutableOnPath("notify-send"),
  };
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

/** The command that shows `notification` on this host, or why none can. */
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
    const title =
      notification.subtitle !== undefined && notification.subtitle.length > 0
        ? `${notification.title}: ${notification.subtitle}`
        : notification.title;
    return { available: true, command: notifySend, args: [title, notification.message] };
  }
  return { available: false, reason: UNSUPPORTED_DESKTOP_PLATFORM };
}

/** Why this host cannot show a desktop notification, or undefined when it can. */
export function desktopNotifierUnavailableReason(
  host: DesktopNotifierHost = currentDesktopNotifierHost(),
): string | undefined {
  const command = desktopNotifierCommand({ title: "", message: "" }, host);
  return command.available ? undefined : command.reason;
}

/** Whether this host has a desktop notifier Jazz can launch. */
export function isDesktopNotifierAvailable(
  host: DesktopNotifierHost = currentDesktopNotifierHost(),
): boolean {
  return desktopNotifierUnavailableReason(host) === undefined;
}

/**
 * Show a native desktop notification. Delivered only when the notifier started and did not
 * exit with an error; a missing notifier, a host without a desktop session, or a notifier that
 * fails is a non-retryable failure whose error says what to install or check.
 */
export function sendDesktopNotification(
  notification: DesktopNotification,
  host: DesktopNotifierHost = currentDesktopNotifierHost(),
  launch: LaunchNotifier = launchDetached,
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

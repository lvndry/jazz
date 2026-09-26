/**
 * Implements `NotificationService`: native macOS notifications via `terminal-notifier` (or an
 * AppleScript fallback), silently a no-op on other platforms.
 */

import { spawn } from "node:child_process";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import {
  NotificationServiceTag,
  type NotificationService,
  type NotificationOptions,
} from "@jazz/core/interfaces/notification";
import { PluginRuntimeServiceTag } from "@jazz/core/interfaces/plugin-runtime";
import { Effect, Layer, Option } from "effect";
import { getTerminalBundleId } from "./terminal-bundle-id";
import { resolveTerminalNotifierBinary } from "./terminal-notifier-path";

/**
 * Launch a notifier without letting it hold the process open. `terminal-notifier -activate`
 * stays alive until the notification is clicked, so a ref'd child (or its stdio pipes)
 * would keep a headless run from exiting once its work is done.
 */
export function launchDetached(
  command: string,
  args: readonly string[],
  callback: (error: Error | null) => void,
): void {
  const child = spawn(command, args, { stdio: "ignore" });
  child.once("error", (error) => callback(error));
  child.once("exit", (code, signal) => {
    if (code === 0 || signal !== null) {
      callback(null);
      return;
    }
    callback(new Error(`${command} exited with code ${code}`));
  });
  child.unref();
}

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sendAppleScriptNotification(
  title: string,
  message: string,
  subtitle: string | undefined,
  sound: boolean,
  callback: (error: Error | null) => void,
): void {
  const soundPart = sound ? ' sound name "Blow"' : "";
  const subtitlePart = subtitle ? ` subtitle "${escapeForAppleScript(subtitle)}"` : "";
  const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"${subtitlePart}${soundPart}`;
  launchDetached("osascript", ["-e", script], callback);
}

function sendNativeNotification(
  title: string,
  message: string,
  subtitle?: string,
  sound?: boolean,
): void {
  const callback = (error: Error | null) => {
    if (error) {
      console.error(`[Notification] Failed to send native notification: ${error.message}`);
    }
  };

  if (process.platform === "darwin") {
    const bundleId = getTerminalBundleId();
    const terminalNotifier = resolveTerminalNotifierBinary();

    if (terminalNotifier && bundleId) {
      const args = ["-title", title, "-message", message, "-activate", bundleId];
      if (subtitle) {
        args.push("-subtitle", subtitle);
      }
      if (sound) {
        args.push("-sound", "Blow");
      }
      launchDetached(terminalNotifier, args, (error) => {
        if (error) {
          console.error(`[Notification] Failed to send via terminal-notifier: ${error.message}`);
          sendAppleScriptNotification(title, message, subtitle, sound ?? false, callback);
        }
      });
      return;
    }

    sendAppleScriptNotification(title, message, subtitle, sound ?? false, callback);
    return;
  }

  if (process.platform === "linux") {
    const args: string[] = [];
    if (sound) args.push("--urgency=normal");
    args.push(title, message);
    launchDetached("notify-send", args, callback);
    return;
  }
}

export class NotificationServiceImpl implements NotificationService {
  notify(message: string, options?: NotificationOptions): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const configService = yield* Effect.serviceOption(AgentConfigServiceTag);
      const appConfig = Option.isSome(configService) ? yield* configService.value.appConfig : null;
      const notificationsConfig = appConfig?.notifications;

      if (notificationsConfig?.enabled === false) {
        return;
      }

      const pluginRuntime = yield* Effect.serviceOption(PluginRuntimeServiceTag);
      if (Option.isSome(pluginRuntime)) {
        const pluginHandles = yield* pluginRuntime.value
          .hasNotificationPlugin()
          .pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (pluginHandles) {
          return;
        }
      }

      const title = options?.title ?? "🎷 Jazz";
      const sound = options?.sound ?? notificationsConfig?.sound ?? true;

      sendNativeNotification(title, message, options?.subtitle, sound);
    });
  }
}

export const NotificationServiceLayer = Layer.succeed(
  NotificationServiceTag,
  new NotificationServiceImpl(),
);

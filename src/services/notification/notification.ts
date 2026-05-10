import { execFile } from "node:child_process";
import { Effect, Layer, Option } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import {
  NotificationServiceTag,
  type NotificationService,
  type NotificationOptions,
} from "@/core/interfaces/notification";

function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
    const soundPart = sound ? ' sound name "Blow"' : "";
    const subtitlePart = subtitle ? ` subtitle "${escapeForAppleScript(subtitle)}"` : "";
    const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"${subtitlePart}${soundPart}`;
    execFile("osascript", ["-e", script], callback);
    return;
  }

  if (process.platform === "linux") {
    const args: string[] = [];
    if (sound) args.push("--urgency=normal");
    args.push(title, message);
    execFile("notify-send", args, callback);
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

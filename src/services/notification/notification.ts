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
  if (process.platform === "darwin") {
    const soundPart = sound ? ' sound name "Blow"' : "";
    const subtitlePart = subtitle ? ` subtitle "${escapeForAppleScript(subtitle)}"` : "";
    const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}"${subtitlePart}${soundPart}`;
    execFile("osascript", ["-e", script]);
    return;
  }

  if (process.platform === "linux") {
    const args = [title, message];
    if (sound) args.push("--urgency=normal");
    execFile("notify-send", args);
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

      try {
        sendNativeNotification(title, message, options?.subtitle, sound);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Notification] Failed to send notification: ${errorMessage}`);
      }
    });
  }
}

export const NotificationServiceLayer = Layer.succeed(
  NotificationServiceTag,
  new NotificationServiceImpl(),
);

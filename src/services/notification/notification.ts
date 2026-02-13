import { Effect, Layer, Option } from "effect";
import notifier, { type Notification } from "node-notifier";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import {
  NotificationServiceTag,
  type NotificationService,
  type NotificationOptions,
} from "@/core/interfaces/notification";

/**
 * Detect the macOS bundle ID for the current terminal emulator.
 * Returns undefined on non-macOS platforms or unrecognized terminals.
 */
function getTerminalBundleId(): string | undefined {
  if (process.platform !== "darwin") return undefined;

  const termProgram = process.env["TERM_PROGRAM"];
  const term = process.env["TERM"];

  if (termProgram === "WarpTerminal") return "dev.warp.Warp-Stable";
  if (termProgram === "iTerm.app") return "com.googlecode.iterm2";
  if (termProgram === "Apple_Terminal") return "com.apple.Terminal";
  if (termProgram === "vscode") return "com.microsoft.VSCode";
  if (process.env["KITTY_WINDOW_ID"]) return "net.kovidgoyal.kitty";
  if (term?.includes("alacritty")) return "org.alacritty";

  return undefined;
}

export class NotificationServiceImpl implements NotificationService {
  notify(message: string, options?: NotificationOptions): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const configService = yield* Effect.serviceOption(AgentConfigServiceTag);
      const appConfig = Option.isSome(configService) ? yield* configService.value.appConfig : null;
      const notificationsConfig = appConfig?.notifications;

      // Check if notifications are explicitly disabled in config
      if (notificationsConfig?.enabled === false) {
        return;
      }

      const title = options?.title ?? "🎷 Jazz";
      const sound = options?.sound ?? notificationsConfig?.sound ?? true;

      try {
        const bundleId = getTerminalBundleId();
        const notifyOptions = {
          title: String(title),
          message: String(message),
          subtitle: options?.subtitle ? String(options.subtitle) : undefined,
          sound: sound && "Blow",
          icon: options?.icon ? String(options.icon) : undefined,
          wait: !!(options?.wait ?? false),
          ...(bundleId && { activate: bundleId }),
        };
        notifier.notify(notifyOptions as Notification);
      } catch (error) {
        // Log error but don't fail - notifications are non-critical
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

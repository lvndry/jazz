import { Effect, Layer, Option } from "effect";
import notifier, { type Notification } from "node-notifier";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { NotificationServiceTag, type NotificationService, type NotificationOptions } from "@/core/interfaces/notification";

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
        const notifyOptions = {
          title: String(title),
          message: String(message),
          subtitle: options?.subtitle ? String(options.subtitle) : undefined,
          sound: !!sound,
          icon: options?.icon ? String(options.icon) : undefined,
          wait: !!(options?.wait ?? false),
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

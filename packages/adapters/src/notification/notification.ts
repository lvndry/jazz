/**
 * Implements `NotificationService`: the desktop notification shown when an agent finishes, sent
 * through the one desktop sender (`desktop-notifier.ts`) unless a plugin handles notifications.
 */

import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import {
  NotificationServiceTag,
  type NotificationService,
  type NotificationOptions,
} from "@jazz/core/interfaces/notification";
import { PluginRuntimeServiceTag } from "@jazz/core/interfaces/plugin-runtime";
import { Effect, Layer, Option } from "effect";
import { isDesktopNotifierAvailable, sendDesktopNotification } from "./desktop-notifier";

let reportedFailure = false;

/** Report the first failed desktop notification of this process; later ones are the same. */
function reportFailureOnce(error: string): void {
  if (reportedFailure) {
    return;
  }
  reportedFailure = true;
  console.error(`[Notification] Could not show a desktop notification: ${error}`);
}

export class NotificationServiceImpl implements NotificationService {
  /** Returns at once; the notifier launches on a background fiber so a run never waits on it. */
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

      yield* sendDesktopNotification({
        title,
        message,
        ...(options?.subtitle !== undefined ? { subtitle: options.subtitle } : {}),
        sound,
      }).pipe(
        Effect.tap((outcome) =>
          outcome.delivered ? Effect.void : Effect.sync(() => reportFailureOnce(outcome.error)),
        ),
        Effect.forkDaemon,
      );
    });
  }

  desktopAvailable(): boolean {
    return isDesktopNotifierAvailable();
  }
}

export const NotificationServiceLayer = Layer.succeed(
  NotificationServiceTag,
  new NotificationServiceImpl(),
);

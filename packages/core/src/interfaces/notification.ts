/**
 * `NotificationService` interface for sending desktop/system notifications.
 */
import { Context, Effect } from "effect";

export interface NotificationOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly sound?: boolean;
  readonly icon?: string;
  readonly wait?: boolean;
  /** Milliseconds after which the notification closes itself, on channels that can close one. */
  readonly expireAfterMs?: number;
}

export interface NotificationService {
  /**
   * Sends a system notification (desktop toast/alert).
   *
   * @param message - The message to display
   * @param options - Optional configuration (title, subtitle, sound)
   */
  readonly notify: (message: string, options?: NotificationOptions) => Effect.Effect<void, never>;

  /**
   * Whether a desktop notification can be shown here: in a terminal that shows notifications,
   * or with an OS notifier (terminal-notifier, notify-send).
   */
  readonly desktopAvailable: () => Effect.Effect<boolean, never>;
}

export const NotificationServiceTag = Context.Service<NotificationService>("NotificationService");

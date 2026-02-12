import { Context, Effect } from "effect";

export interface NotificationOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly sound?: boolean;
  readonly icon?: string;
  readonly wait?: boolean;
}

export interface NotificationService {
  /**
   * Sends a system notification (desktop toast/alert).
   *
   * @param message - The message to display
   * @param options - Optional configuration (title, subtitle, sound)
   */
  readonly notify: (message: string, options?: NotificationOptions) => Effect.Effect<void, never>;
}

export const NotificationServiceTag =
  Context.GenericTag<NotificationService>("NotificationService");

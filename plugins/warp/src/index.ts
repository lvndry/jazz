/**
 * A Warp (and general desktop) notification plugin. It subscribes to Jazz lifecycle events and
 * raises a native notification when a task finishes or when Jazz is waiting for you — the same
 * shape as warpdotdev/claude-code-warp, which rides Claude Code's hook system.
 *
 * Notifications are best-effort: delivery is platform-guarded and any failure is swallowed, and
 * lifecycle handlers are fire-and-forget, so nothing here can delay or break a run.
 */

import { spawn } from "node:child_process";
import type { JazzPluginModule, LifecycleEvent } from "@jazz/plugin-sdk";

export interface Notification {
  readonly title: string;
  readonly body: string;
}

const MAX_BODY_CHARS = 200;

/** The notification for a lifecycle event, or undefined for events this plugin doesn't announce. */
export function notificationFor(event: LifecycleEvent): Notification | undefined {
  switch (event.event) {
    case "run-complete": {
      const summary =
        typeof event.data?.["summary"] === "string" ? event.data["summary"].trim() : "";
      return {
        title: "Jazz — task complete",
        body:
          summary.length > 0 ? summary.slice(0, MAX_BODY_CHARS) : "The agent finished the task.",
      };
    }
    case "awaiting-input":
      return { title: "Jazz — waiting for you", body: "The agent is ready for your next message." };
    default:
      return undefined;
  }
}

/** Raise a native notification. No-op under JAZZ_WARP_SILENT and on unsupported platforms. */
function sendNotification(title: string, body: string): void {
  if (process.env["JAZZ_WARP_SILENT"] === "1") return;
  try {
    if (process.platform === "darwin") {
      const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
      spawn("osascript", ["-e", script], { stdio: "ignore" }).unref();
    } else if (process.platform === "linux") {
      spawn("notify-send", [title, body], { stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort: a missing notifier binary must never surface to the run.
  }
}

const plugin: JazzPluginModule = {
  apiVersion: 1,
  register(api) {
    for (const event of ["run-complete", "awaiting-input"] as const) {
      api.lifecycle.register({
        event,
        handler: (received) => {
          const notification = notificationFor(received);
          if (notification) sendNotification(notification.title, notification.body);
          return Promise.resolve();
        },
      });
    }
  },
};

export default plugin;

/**
 * Best-effort native OS desktop notification, used to deliver a CLI-hosted agent's reminder
 * without resuming a conversation. A headless server, an SSH session, or an unsupported OS must
 * never make this fail its caller — the error channel is intentionally `never`.
 */
import { Effect } from "effect";
import { execCommand } from "./shell";

/**
 * Escape a string for interpolation into an AppleScript string literal.
 *
 * This is distinct from shell escaping: `script` below is still passed as a single argv element
 * to `execCommand("osascript", ["-e", script])` with `shell: false`, so there is no shell to
 * inject into. The escaping here only protects AppleScript's own string-literal syntax from the
 * quotes and backslashes that might appear in a reminder's text.
 */
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sendMacOsNotification(title: string, body: string): Effect.Effect<boolean, never> {
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
  return execCommand("osascript", ["-e", script]).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

function sendLinuxNotification(title: string, body: string): Effect.Effect<boolean, never> {
  return execCommand("which", ["notify-send"]).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((hasNotifySend) =>
      hasNotifySend
        ? execCommand("notify-send", [title, body]).pipe(
            Effect.map(() => true),
            Effect.catchAll(() => Effect.succeed(false)),
          )
        : Effect.succeed(false),
    ),
  );
}

/**
 * Send a native OS desktop notification. Returns `true` on apparent success, `false` when the
 * platform is unsupported, the platform tool is missing, or anything else goes wrong — a failed
 * notification is never a failure of the caller (typically a reminder firing).
 */
export function sendDesktopNotification(
  title: string,
  body: string,
): Effect.Effect<boolean, never> {
  if (process.platform === "darwin") {
    return sendMacOsNotification(title, body);
  }
  if (process.platform === "linux") {
    return sendLinuxNotification(title, body);
  }
  return Effect.succeed(false);
}

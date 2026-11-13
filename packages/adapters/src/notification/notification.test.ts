/**
 * Exercises automatic completion notifications with injected host capabilities. Unavailable
 * desktops must return before scheduling delivery or reporting a failure on stderr.
 */
import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";
import * as desktopNotifier from "./desktop-notifier";
import { NotificationServiceImpl } from "./notification";

test.each(["linux", "darwin"] as const)(
  "automatic notifications quietly skip an unavailable %s desktop",
  async (platform) => {
    const currentHost = spyOn(desktopNotifier, "currentDesktopNotifierHost");
    const send = spyOn(desktopNotifier, "sendDesktopNotification");
    const report = spyOn(console, "error");
    try {
      currentHost.mockReturnValue({
        platform,
        env: platform === "darwin" ? { CI: "true" } : {},
        resolveTerminalNotifier: () => "/opt/jazz/terminal-notifier",
        findNotifySend: () => null,
        hasMacDesktopSession: () => platform !== "darwin",
        canWriteTerminal: () => false,
        writeTerminal: () => false,
      });
      send.mockReturnValue(
        Effect.succeed({ delivered: false, error: "unavailable", retryable: false }),
      );
      report.mockImplementation(() => {});

      const service = new NotificationServiceImpl();
      await Effect.runPromise(service.notify("Finished"));
      await Effect.runPromise(Effect.yieldNow);

      expect(send).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    } finally {
      currentHost.mockRestore();
      send.mockRestore();
      report.mockRestore();
    }
  },
);

test("automatic notifications still send on an available desktop", async () => {
  const currentHost = spyOn(desktopNotifier, "currentDesktopNotifierHost");
  const send = spyOn(desktopNotifier, "sendDesktopNotification");
  try {
    currentHost.mockReturnValue({
      platform: "linux",
      env: { DISPLAY: ":0" },
      resolveTerminalNotifier: () => null,
      findNotifySend: () => "/usr/bin/notify-send",
      hasMacDesktopSession: () => false,
      canWriteTerminal: () => false,
      writeTerminal: () => false,
    });
    send.mockReturnValue(Effect.succeed({ delivered: true }));

    await Effect.runPromise(new NotificationServiceImpl().notify("Finished"));
    await Effect.runPromise(Effect.yieldNow);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ message: "Finished" });
  } finally {
    currentHost.mockRestore();
    send.mockRestore();
  }
});

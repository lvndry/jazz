import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type DesktopNotifierHost,
  desktopNotifierCommand,
  isDesktopNotifierAvailable,
  type LaunchNotifier,
  launchDetached,
  NO_DESKTOP_SESSION,
  NOTIFY_SEND_MISSING,
  sendDesktopNotification,
  TERMINAL_NOTIFIER_MISSING,
  UNSUPPORTED_DESKTOP_PLATFORM,
} from "./desktop-notifier";

const LINGERING_NOTIFIER_SECONDS = 15;
const EXIT_DEADLINE_MS = 5_000;
const SHORT_GRACE_MS = 200;

function host(overrides: Partial<DesktopNotifierHost>): DesktopNotifierHost {
  return {
    platform: "darwin",
    env: {},
    resolveTerminalNotifier: () => "/opt/jazz/terminal-notifier",
    findNotifySend: () => "/usr/bin/notify-send",
    ...overrides,
  };
}

function recordingLauncher(outcome: Awaited<ReturnType<LaunchNotifier>>) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const launch: LaunchNotifier = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(outcome);
  };
  return { calls, launch };
}

describe("launchDetached", () => {
  test(
    "a notifier that never exits does not keep a piped parent process alive",
    async () => {
      const script = `
      import { launchDetached } from ${JSON.stringify(join(import.meta.dir, "desktop-notifier.ts"))};
      void launchDetached("sleep", ["${LINGERING_NOTIFIER_SECONDS}"]);
    `;
      const parent = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const startedAt = Date.now();
      const drained = Promise.all([
        new Response(parent.stdout).text(),
        new Response(parent.stderr).text(),
        parent.exited,
      ]);
      const deadline = new Promise<"timed-out">((resolve) =>
        setTimeout(() => resolve("timed-out"), EXIT_DEADLINE_MS),
      );

      const outcome = await Promise.race([drained, deadline]);
      if (outcome === "timed-out") {
        parent.kill(9);
      }

      expect(outcome).not.toBe("timed-out");
      expect(Date.now() - startedAt).toBeLessThan(EXIT_DEADLINE_MS);
    },
    EXIT_DEADLINE_MS * 2,
  );

  test("reports a non-zero exit as not launched", async () => {
    const outcome = await launchDetached("false", []);
    expect(outcome).toEqual({ launched: false, error: "false exited with code 1" });
  });

  test("reports a missing binary as not launched", async () => {
    const outcome = await launchDetached("/nonexistent/jazz-notifier", []);
    expect(outcome.launched).toBe(false);
  });

  test("reports a clean exit as launched", async () => {
    expect(await launchDetached("true", [])).toEqual({ launched: true });
  });

  test("reports a notifier still running after the grace period as launched", async () => {
    expect(await launchDetached("sleep", ["5"], SHORT_GRACE_MS)).toEqual({ launched: true });
  });
});

describe("desktopNotifierCommand", () => {
  test("uses terminal-notifier on macOS", () => {
    const command = desktopNotifierCommand(
      { title: "Jazz", message: 'say "hi" \\ there', subtitle: "sub", sound: true },
      host({}),
    );
    expect(command.available).toBe(true);
    if (command.available) {
      expect(command.command).toBe("/opt/jazz/terminal-notifier");
      expect(command.args).toContain('say "hi" \\ there');
      expect(command.args).toContain("-subtitle");
      expect(command.args).toContain("-sound");
    }
  });

  test("names terminal-notifier as missing on macOS without one", () => {
    expect(
      desktopNotifierCommand(
        { title: "Jazz", message: "hi" },
        host({ resolveTerminalNotifier: () => null }),
      ),
    ).toEqual({ available: false, reason: TERMINAL_NOTIFIER_MISSING });
  });

  test("uses notify-send on Linux with a desktop session", () => {
    const command = desktopNotifierCommand(
      { title: "Jazz", message: "hi" },
      host({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }),
    );
    expect(command).toEqual({
      available: true,
      command: "/usr/bin/notify-send",
      args: ["Jazz", "hi"],
    });
  });

  test("refuses on Linux without notify-send or without a desktop session", () => {
    expect(
      desktopNotifierCommand(
        { title: "Jazz", message: "hi" },
        host({ platform: "linux", env: { DISPLAY: ":0" }, findNotifySend: () => null }),
      ),
    ).toEqual({ available: false, reason: NOTIFY_SEND_MISSING });
    expect(
      desktopNotifierCommand({ title: "Jazz", message: "hi" }, host({ platform: "linux" })),
    ).toEqual({ available: false, reason: NO_DESKTOP_SESSION });
  });

  test("refuses on other platforms", () => {
    expect(isDesktopNotifierAvailable(host({ platform: "win32" }))).toBe(false);
    expect(
      desktopNotifierCommand({ title: "Jazz", message: "hi" }, host({ platform: "win32" })),
    ).toEqual({ available: false, reason: UNSUPPORTED_DESKTOP_PLATFORM });
  });
});

describe("sendDesktopNotification", () => {
  test("is delivered only when the notifier launched", async () => {
    const { calls, launch } = recordingLauncher({ launched: true });
    const outcome = await Effect.runPromise(
      sendDesktopNotification({ title: "Jazz", message: "hi" }, host({}), launch),
    );
    expect(outcome).toEqual({ delivered: true });
    expect(calls.map((call) => call.command)).toEqual(["/opt/jazz/terminal-notifier"]);
  });

  test("fails without a fallback when terminal-notifier cannot launch", async () => {
    const { calls, launch } = recordingLauncher({
      launched: false,
      error: "terminal-notifier exited with code 1",
    });
    const outcome = await Effect.runPromise(
      sendDesktopNotification({ title: "Jazz", message: "hi" }, host({}), launch),
    );
    expect(outcome).toEqual({
      delivered: false,
      error: "terminal-notifier exited with code 1",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  test("fails without launching anything when terminal-notifier is missing", async () => {
    const { calls, launch } = recordingLauncher({ launched: true });
    const outcome = await Effect.runPromise(
      sendDesktopNotification(
        { title: "Jazz", message: "hi" },
        host({ resolveTerminalNotifier: () => null }),
        launch,
      ),
    );
    expect(outcome).toEqual({
      delivered: false,
      error: TERMINAL_NOTIFIER_MISSING,
      retryable: false,
    });
    expect(calls).toEqual([]);
  });
});

/**
 * Tier-1 scripted-driver scenarios from docs/design/computer-use-completeness.md.
 *
 * Most scenarios (consent-first-reach, noop-recovery, stale-ref, roundtrip economy, secret
 * typing, blocked keys, wait settled/changed) already have dedicated tests in
 * computer-tools.test.ts, session.test.ts, and wait.test.ts; this file covers the two that do
 * not: the capability gate against a driver build that lacks a kind, and a stop landing in the
 * middle of a wait.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { requestStop } from "./control";
import { CAPABILITY_UNSUPPORTED_CODE, DriverError } from "./driver";
import { FakeDriver, mailApp } from "./fake-driver";
import { computerDirectory } from "./grants";
import { ComputerSession, ComputerStoppedError, type ComputerSessionSettings } from "./session";
import { useTemporaryJazzHome } from "./test-home";

useTemporaryJazzHome();

function sessionWithDriver(capabilities: readonly string[]) {
  const clock = { now: Date.now() };
  const base = mailApp();
  const app = { ...base, windows: base.windows.map((window) => ({ ...window })) };
  const driver = new FakeDriver([app], capabilities);
  const state = {
    version: 1 as const,
    grants: [
      {
        bundleId: "com.apple.mail",
        grantedAt: clock.now,
        expiresAt: Number.MAX_SAFE_INTEGER,
        idleTimeoutMs: 600_000,
        foreground: false,
      },
    ],
  };
  const settings: ComputerSessionSettings = {
    driver,
    releaseLock: () => Promise.resolve(),
    agentId: "agent-1",
    conversationId: "conversation-1",
    capturesDirectory: join(computerDirectory(), "captures", "conversation-1"),
    announce: () => {},
    ancestorPids: new Set(),
    now: () => clock.now,
    readState: () => Promise.resolve(state),
  };
  return { session: new ComputerSession(settings), driver };
}

describe("scenario: capability gate", () => {
  test("an action kind the driver build lacks fails with a named error; others still work", async () => {
    const { session, driver } = sessionWithDriver(["double_click", "triple_click"]);
    try {
      await session.observe({ screenshot: false }, []);

      const click = await session.perform(
        { kind: "click", ref: "c1.0", delivery: "background" },
        [],
      );
      expect(click.effect).toBe("confirmed");

      const dragError: unknown = await session
        .perform({ kind: "drag", fromRef: "c1.0", toRef: "c1.1", delivery: "background" }, [])
        .then(
          () => {
            throw new Error("drag unexpectedly succeeded");
          },
          (error) => error,
        );
      expect(dragError).toBeInstanceOf(DriverError);
      expect((dragError as DriverError).code).toBe(CAPABILITY_UNSUPPORTED_CODE);

      // The unsupported action never reached the driver.
      expect(driver.actions.map((action) => action.kind)).toEqual(["click"]);
    } finally {
      await session.close();
    }
  });
});

describe("scenario: stop during an in-flight wait", () => {
  test("requesting a stop ends a wait at the next poll", async () => {
    const base = mailApp();
    const app = { ...base, windows: base.windows.map((window) => ({ ...window })) };
    const windowCopy = app.windows[0];
    const clock = { now: Date.now() };
    const driver = new FakeDriver([app]);
    const state = {
      version: 1 as const,
      grants: [
        {
          bundleId: "com.apple.mail",
          grantedAt: clock.now,
          expiresAt: Number.MAX_SAFE_INTEGER,
          idleTimeoutMs: 600_000,
          foreground: false,
        },
      ],
    };
    const session = new ComputerSession({
      driver,
      releaseLock: () => Promise.resolve(),
      agentId: "agent-1",
      conversationId: "conversation-1",
      capturesDirectory: join(computerDirectory(), "captures", "conversation-1"),
      announce: () => undefined,
      ancestorPids: new Set<number>(),
      now: () => clock.now,
      readState: () => Promise.resolve(state),
    });
    try {
      await session.observe({ screenshot: false }, []);
      // The window changes on every poll, so the wait would otherwise run to its timeout.
      let ticks = 0;
      driver.mutate = () => {
        ticks += 1;
        if (windowCopy !== undefined) {
          windowCopy.elements = [
            ...windowCopy.elements,
            { role: "AXButton", label: `t${String(ticks)}` },
          ];
        }
      };
      const waiting = session.wait({ timeoutMs: 10_000, pollMs: 50, until: "settled" });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await requestStop();
      await expect(waiting).rejects.toBeInstanceOf(ComputerStoppedError);
    } finally {
      await session.close().catch(() => undefined);
    }
  });
});

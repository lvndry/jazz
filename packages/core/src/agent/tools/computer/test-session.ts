/**
 * A session over a fake driver, with a clock and grant list the test controls, for the tests of
 * the session and of the tools built on it.
 */

import path from "node:path";
import { type FakeApp, FakeDriver } from "./fake-driver";
import { type ComputerGrant, type ComputerState, computerDirectory } from "./grants";
import { ComputerSession } from "./session";

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

export function grantFor(
  bundleId: string,
  clock: { now: number },
  overrides: Partial<ComputerGrant> = {},
): ComputerGrant {
  return {
    bundleId,
    grantedAt: clock.now,
    expiresAt: clock.now + 8 * HOUR,
    idleTimeoutMs: 30 * MINUTE,
    foreground: false,
    ...overrides,
  };
}

export function textEditorApp(): FakeApp {
  return {
    pid: 202,
    name: "Code",
    bundleId: "com.microsoft.VSCode",
    windows: [
      {
        windowId: 2,
        title: "main.ts",
        elements: [
          { role: "AXButton", label: "Run" },
          { role: "AXTextArea", label: "Editor" },
        ],
      },
    ],
  };
}

export function browserApp(): FakeApp {
  return {
    pid: 303,
    name: "Safari",
    bundleId: "com.apple.Safari",
    windows: [{ windowId: 3, title: "Bank", elements: [{ role: "AXButton", label: "Transfer" }] }],
  };
}

export function terminalApp(): FakeApp {
  return {
    pid: 404,
    name: "Terminal",
    bundleId: "com.apple.Terminal",
    windows: [{ windowId: 4, title: "zsh", elements: [{ role: "AXTextArea", label: "shell" }] }],
  };
}

export interface Started {
  readonly session: ComputerSession;
  readonly driver: FakeDriver;
  readonly clock: { now: number };
  readonly state: ComputerState & { grants: ComputerGrant[] };
  readonly announcements: string[];
  readonly lockReleases: () => number;
}

export function startSession(
  apps: readonly FakeApp[],
  bundleIds: readonly string[],
  options: { foreground?: boolean; ancestors?: readonly number[] } = {},
): Started {
  const clock = { now: Date.now() };
  const driver = new FakeDriver(apps);
  const state = {
    version: 1 as const,
    grants: bundleIds.map((bundleId) =>
      grantFor(bundleId, clock, { foreground: options.foreground === true }),
    ),
  };
  const announcements: string[] = [];
  let releases = 0;
  const session = new ComputerSession({
    driver,
    releaseLock: () => {
      releases += 1;
      return Promise.resolve();
    },
    agentId: "agent-1",
    conversationId: "conversation-1",
    capturesDirectory: path.join(computerDirectory(), "captures", "conversation-1"),
    announce: (message) => announcements.push(message),
    ancestorPids: new Set(options.ancestors ?? []),
    now: () => clock.now,
    readState: () => Promise.resolve(state),
  });
  return { session, driver, clock, state, announcements, lockReleases: () => releases };
}

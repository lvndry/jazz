import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { acquireComputerLock, LOCK_HELD_MESSAGE, readSessionInfo } from "./control";
import { DRIVER_COMMAND, DRIVER_PATH_ENV, UNSUPPORTED_PLATFORM_MESSAGE } from "./driver-pin";
import { FakeDriver, mailApp } from "./fake-driver";
import type { ComputerGrant, ComputerState } from "./grants";
import { openComputerSession, processAncestry, SESSION_STARTED_MESSAGE } from "./open";
import { useTemporaryJazzHome } from "./test-home";

useTemporaryJazzHome();

const HOUR = 60 * 60 * 1000;

function installDriver(content: string): {
  readonly environment: NodeJS.ProcessEnv;
  readonly sha256: string;
  readonly file: string;
} {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "open-session-")));
  const file = path.join(directory, DRIVER_COMMAND);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return {
    environment: { [DRIVER_PATH_ENV]: file },
    sha256: createHash("sha256").update(content).digest("hex"),
    file,
  };
}

function grant(now: number): ComputerGrant {
  return {
    bundleId: "com.apple.mail",
    grantedAt: now,
    expiresAt: now + 8 * HOUR,
    idleTimeoutMs: 30 * 60 * 1000,
    foreground: false,
  };
}

function stateWith(
  driver: ReturnType<typeof installDriver>,
  grants: readonly ComputerGrant[],
): ComputerState {
  return {
    version: 1,
    acknowledgement: { acknowledgedAt: 1, driverPath: driver.file, driverSha256: driver.sha256 },
    grants: [...grants],
  };
}

function options(
  driver: ReturnType<typeof installDriver>,
  state: ComputerState,
  overrides: Partial<Parameters<typeof openComputerSession>[0]> = {},
) {
  const fake = new FakeDriver([mailApp()]);
  return {
    announcements: [] as string[],
    fake,
    value: {
      agentId: "agent",
      conversationId: "conversation",
      announce: () => undefined,
      openDriver: async () => fake,
      isSupported: () => true,
      readState: async () => state,
      environment: driver.environment,
      ...overrides,
    } satisfies Parameters<typeof openComputerSession>[0],
  };
}

describe("openComputerSession", () => {
  test("refuses an unsupported machine before doing anything else", async () => {
    const driver = installDriver("driver");
    const { value } = options(driver, stateWith(driver, [grant(Date.now())]), {
      isSupported: () => false,
    });

    await expect(openComputerSession(value)).rejects.toThrow(UNSUPPORTED_PLATFORM_MESSAGE);
  });

  test("first successful session pins the driver without separate acknowledgement", async () => {
    const driver = installDriver("driver");
    const state: ComputerState = { version: 1, grants: [grant(Date.now())] };
    let pinned: { path: string; sha256: string } | undefined;
    const { value } = options(driver, state, {
      pinDriver: async (driverPath, sha256) => {
        pinned = { path: driverPath, sha256 };
      },
    });
    const session = await openComputerSession(value);
    expect(pinned).toEqual({ path: driver.file, sha256: driver.sha256 });
    await session.close();
  });

  test("failed driver start does not create a pin", async () => {
    const driver = installDriver("driver");
    let pinned = false;
    const { value } = options(
      driver,
      { version: 1, grants: [] },
      {
        openDriver: async () => {
          throw new Error("driver failed");
        },
        pinDriver: async () => {
          pinned = true;
        },
      },
    );
    await expect(openComputerSession(value)).rejects.toThrow("driver failed");
    expect(pinned).toBe(false);
  });

  test("refuses a driver that changed since it was acknowledged", async () => {
    const acknowledged = installDriver("build one");
    const installed = installDriver("build two");
    const state = stateWith(acknowledged, [grant(Date.now())]);
    const { value } = options(installed, state);

    await expect(openComputerSession(value)).rejects.toThrow("changed since its first use");
  });
  test("opens with no grant: consent is asked on the first reach of each app", async () => {
    const driver = installDriver("driver");
    const { value } = options(driver, stateWith(driver, []));

    const session = await openComputerSession(value);
    expect((await session.apps())[0]?.name).toBe("Mail");
    await session.close();
  });

  test("refuses when another run holds the desktop, without starting the driver", async () => {
    const driver = installDriver("driver");
    let started = 0;
    const { value } = options(driver, stateWith(driver, [grant(Date.now())]), {
      openDriver: async () => {
        started += 1;
        return new FakeDriver([]);
      },
    });
    const release = await acquireComputerLock();

    await expect(openComputerSession(value)).rejects.toThrow(LOCK_HELD_MESSAGE);
    await release();

    expect(started).toBe(0);
  });

  test("releases the lock when the driver fails to start", async () => {
    const driver = installDriver("driver");
    const { value } = options(driver, stateWith(driver, [grant(Date.now())]), {
      openDriver: async () => {
        throw new Error("driver would not start");
      },
    });

    await expect(openComputerSession(value)).rejects.toThrow("driver would not start");

    const release = await acquireComputerLock();
    await release();
  });

  test("starts a session, records it for `jazz computer stop`, announces it, and cleans up on close", async () => {
    const driver = installDriver("driver");
    const announcements: string[] = [];
    const { value, fake } = options(driver, stateWith(driver, [grant(Date.now())]), {
      announce: (message) => announcements.push(message),
    });

    const session = await openComputerSession(value);

    expect(announcements).toEqual([SESSION_STARTED_MESSAGE]);
    expect((await readSessionInfo())?.pid).toBe(process.pid);
    expect((await session.apps())[0]?.name).toBe("Mail");
    await expect(acquireComputerLock()).rejects.toThrow(LOCK_HELD_MESSAGE);

    await session.close();

    expect(fake.closes).toBe(1);
    expect(await readSessionInfo()).toBeUndefined();
    const release = await acquireComputerLock();
    await release();
  });
});

describe("processAncestry", () => {
  test("includes this process and its parent", () => {
    const chain = processAncestry();
    expect(chain.has(process.pid)).toBe(true);
    expect(chain.has(process.ppid)).toBe(true);
  });
});

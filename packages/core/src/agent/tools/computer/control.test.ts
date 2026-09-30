import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { currentProcessOwner } from "@/core/utils/process";
import {
  acquireComputerLock,
  clearSessionInfo,
  clearStopRequest,
  LOCK_HELD_MESSAGE,
  readSessionInfo,
  requestStop,
  stopRequestedSince,
  writeSessionInfo,
} from "./control";
import { computerDirectory } from "./grants";
import { useTemporaryJazzHome } from "./test-home";

useTemporaryJazzHome();

function plantLock(holder: object): void {
  const lock = path.join(computerDirectory(), "run.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ token: "planted", ...holder }));
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("the machine-wide run lock", () => {
  test("gives the desktop to one run and tells a second who is using it", async () => {
    const release = await acquireComputerLock();
    await expect(acquireComputerLock()).rejects.toThrow(LOCK_HELD_MESSAGE);
    await release();
    const again = await acquireComputerLock();
    await again();
  });

  test("is reclaimed when the run that held it died", async () => {
    plantLock({ pid: await deadPid(), host: hostname() });
    const release = await acquireComputerLock();
    await release();
  });

  test("is never taken from a holder that is still running", async () => {
    plantLock(currentProcessOwner());
    await expect(acquireComputerLock()).rejects.toThrow(LOCK_HELD_MESSAGE);
  });
});

describe("the session record", () => {
  test("is written for `jazz computer stop` to read, and cleared at the end", async () => {
    await writeSessionInfo({ pid: 10, driverPid: 11, conversationId: "c", startedAt: 5 });
    expect(await readSessionInfo()).toEqual({
      pid: 10,
      driverPid: 11,
      conversationId: "c",
      startedAt: 5,
    });
    await clearSessionInfo();
    expect(await readSessionInfo()).toBeUndefined();
  });
});

describe("stopping a run", () => {
  test("a stop request is seen by a session that started before it", async () => {
    const startedAt = Date.now() - 1_000;
    expect(await stopRequestedSince(startedAt)).toBe(false);
    await requestStop();
    expect(await stopRequestedSince(startedAt)).toBe(true);
  });

  test("a stop request from before a session started does not stop it", async () => {
    await requestStop();
    await Bun.sleep(20);
    expect(await stopRequestedSince(Date.now())).toBe(false);
  });

  test("a new session clears an earlier request", async () => {
    await requestStop();
    await clearStopRequest();
    expect(await stopRequestedSince(0)).toBe(false);
  });

  test("signals the driver process so an action in flight fails at once", async () => {
    const driver = Bun.spawn(["sleep", "30"]);
    await writeSessionInfo({
      pid: process.pid,
      driverPid: driver.pid,
      conversationId: undefined,
      startedAt: 1,
    });

    const session = await requestStop();
    await driver.exited;

    expect(session?.driverPid).toBe(driver.pid);
    expect(driver.signalCode).toBe("SIGTERM");
  });

  test("is safe when nothing is running", async () => {
    expect(await requestStop()).toBeUndefined();
  });
});

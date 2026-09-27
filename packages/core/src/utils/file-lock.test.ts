import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { currentProcessOwner } from "@/core/utils/process";
import { acquireFileLock, withFileLock } from "@jazz/core/utils/file-lock";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "file-lock-")), "state.lock.d");
}

function plantHolder(lockDirectory: string, holder: object, ageMs = 0): void {
  mkdirSync(lockDirectory);
  writeFileSync(join(lockDirectory, "owner.json"), JSON.stringify({ token: "planted", ...holder }));
  const when = new Date(Date.now() - ageMs);
  utimesSync(lockDirectory, when, when);
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("acquireFileLock", () => {
  it("reclaims a lock whose holder process is gone", async () => {
    const lock = lockPath();
    plantHolder(lock, { pid: await deadPid(), host: hostname() });
    const release = await acquireFileLock(lock, { maxWaitMs: 1_000 });
    await release();
  });

  it("never steals a lock from a live holder", async () => {
    const lock = lockPath();
    plantHolder(lock, currentProcessOwner());
    await expect(acquireFileLock(lock, { maxWaitMs: 200 })).rejects.toThrow("Timed out");
  });

  it("never reclaims a live local holder by age, however long it has held the lock", async () => {
    const lock = lockPath();
    plantHolder(lock, currentProcessOwner(), 60_000);
    await expect(acquireFileLock(lock, { maxWaitMs: 200, maxHoldMs: 1_000 })).rejects.toThrow(
      "Timed out",
    );
  });

  it("reclaims a lock left unstamped by a crash once it is older than the stale window", async () => {
    const lock = lockPath();
    mkdirSync(lock);
    const when = new Date(Date.now() - 5_000);
    utimesSync(lock, when, when);
    const release = await acquireFileLock(lock, { maxWaitMs: 1_000, staleMs: 1_000 });
    await release();
  });

  it("reclaims a remote holder that kept the lock past the longest hold", async () => {
    const lock = lockPath();
    plantHolder(lock, { pid: 1, host: "another-host" }, 5_000);
    const release = await acquireFileLock(lock, { maxWaitMs: 1_000, maxHoldMs: 1_000 });
    await release();
  });

  /**
   * The regression: two waiters that both judged a dead holder stale took turns renaming the
   * lock aside, so the second removed the first's fresh lock and both held it at once.
   */
  it("lets only one of several waiters in after reclaiming a dead holder", async () => {
    const lock = lockPath();
    plantHolder(lock, { pid: await deadPid(), host: hostname() });
    let inside = 0;
    let mostInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withFileLock(
          lock,
          async () => {
            inside += 1;
            mostInside = Math.max(mostInside, inside);
            await Bun.sleep(20);
            inside -= 1;
          },
          { maxWaitMs: 5_000, retryDelayMs: 5 },
        ),
      ),
    );
    expect(mostInside).toBe(1);
  });

  it("does not remove a lock someone else acquired after this one was reclaimed", async () => {
    const lock = lockPath();
    const release = await acquireFileLock(lock);
    const { rmSync } = await import("node:fs");
    rmSync(lock, { recursive: true });
    plantHolder(lock, currentProcessOwner());
    await release();
    await expect(acquireFileLock(lock, { maxWaitMs: 200 })).rejects.toThrow("Timed out");
  });
});

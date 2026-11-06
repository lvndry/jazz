import { hostname } from "node:os";
import { describe, expect, it, jest, setSystemTime } from "bun:test";
import { currentProcessOwner, localOwnerStatus } from "./process";

describe("localOwnerStatus", () => {
  it("knows this process is alive", () => {
    expect(localOwnerStatus(currentProcessOwner())).toBe("alive");
  });

  it("keeps its process identity when the wall clock moves", () => {
    const original = currentProcessOwner();
    try {
      setSystemTime(new Date(Date.now() + 3_600_000));
      expect(currentProcessOwner()).toEqual(original);
      expect(localOwnerStatus(currentProcessOwner())).toBe("alive");
    } finally {
      setSystemTime();
    }
  });

  it("keeps its birth stamp when runtime timers use a virtual clock", () => {
    const original = currentProcessOwner();
    try {
      setSystemTime(new Date("2020-01-01T00:00:00Z"));
      jest.useFakeTimers();
      expect(currentProcessOwner()).toEqual(original);
      expect(localOwnerStatus(currentProcessOwner())).toBe("alive");
    } finally {
      jest.useRealTimers();
      setSystemTime();
    }
  });

  it("treats a live pid with a different start time as a reused pid, so its owner is gone", () => {
    const owner = currentProcessOwner();
    expect(localOwnerStatus({ ...owner, startedAt: (owner.startedAt ?? 0) - 3_600_000 })).toBe(
      "gone",
    );
  });

  it("does not judge an owner on another host", () => {
    expect(localOwnerStatus({ ...currentProcessOwner(), host: `${hostname()}-elsewhere` })).toBe(
      "unverifiable",
    );
  });

  it("reports a pid nothing is running under as gone", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    expect(localOwnerStatus({ pid: child.pid, host: hostname() })).toBe("gone");
  });
});

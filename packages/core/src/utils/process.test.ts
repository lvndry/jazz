import { hostname } from "node:os";
import { describe, expect, it } from "bun:test";
import { currentProcessOwner, localOwnerStatus } from "./process";

describe("localOwnerStatus", () => {
  it("knows this process is alive", () => {
    expect(localOwnerStatus(currentProcessOwner())).toBe("alive");
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

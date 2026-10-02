import { describe, expect, test } from "bun:test";
import { runDoctor } from "./doctor";
import { DriverError } from "./driver";
import { FakeDriver, mailApp } from "./fake-driver";
import type { ComputerGrant, ComputerState } from "./grants";

const HOUR = 60 * 60 * 1000;
const SHA = "a".repeat(64);

function grant(now: number): ComputerGrant {
  return {
    bundleId: "com.apple.mail",
    grantedAt: now,
    expiresAt: now + HOUR,
    idleTimeoutMs: 600_000,
    foreground: false,
  };
}

function readyState(now: number): ComputerState {
  return {
    version: 1,
    acknowledgement: { acknowledgedAt: 1, driverPath: "/bin/cua-driver", driverSha256: SHA },
    grants: [grant(now)],
  };
}

function ready(
  overrides: Partial<Parameters<typeof runDoctor>[0]> = {},
): Parameters<typeof runDoctor>[0] {
  const now = Date.now();
  return {
    isSupported: () => true,
    resolveExecutable: async () => "/bin/cua-driver",
    hashExecutable: async () => SHA,
    readState: async () => readyState(now),
    openDriver: async () => new FakeDriver([mailApp()]),
    now: () => now,
    ...overrides,
  };
}

const statusOf = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
  report.checks.find((check) => check.name === name)?.status;

describe("runDoctor", () => {
  test("reports a ready machine with exit code 0", async () => {
    const report = await runDoctor(ready());

    expect(report.exitCode).toBe(0);
    expect(report.checks.map((check) => check.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
  });

  test("lists the capabilities the installed driver build serves", async () => {
    const report = await runDoctor(ready());
    expect(statusOf(report, "capabilities")).toBe("ok");
  });

  test("flags the extended actions a driver build does not serve", async () => {
    const report = await runDoctor(
      ready({
        openDriver: async () => new FakeDriver([mailApp()], ["double_click", "triple_click"]),
      }),
    );
    expect(report.exitCode).toBe(1);
    expect(statusOf(report, "capabilities")).toBe("attention");
    const detail = report.checks.find((check) => check.name === "capabilities")?.detail ?? "";
    expect(detail).toContain("drag");
    expect(detail).toContain("hover");
    expect(detail).toContain("set_value");
  });

  test("blocks an unsupported machine before looking for the driver", async () => {
    let looked = false;
    const report = await runDoctor(
      ready({
        isSupported: () => false,
        resolveExecutable: async () => {
          looked = true;
          return undefined;
        },
      }),
    );

    expect(report.exitCode).toBe(2);
    expect(statusOf(report, "platform")).toBe("blocked");
    expect(looked).toBe(false);
  });

  test("blocks when there is no driver", async () => {
    const report = await runDoctor(ready({ resolveExecutable: async () => undefined }));

    expect(report.exitCode).toBe(2);
    expect(statusOf(report, "driver")).toBe("blocked");
  });

  test("asks for attention, exit code 1, when computer use was never acknowledged", async () => {
    const report = await runDoctor(ready({ readState: async () => ({ version: 1, grants: [] }) }));

    expect(report.exitCode).toBe(1);
    expect(statusOf(report, "acknowledgement")).toBe("attention");
    expect(statusOf(report, "grants")).toBe("attention");
  });

  test("asks for attention when the driver changed since it was acknowledged", async () => {
    const report = await runDoctor(ready({ hashExecutable: async () => "b".repeat(64) }));

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((check) => check.name === "acknowledgement")?.detail).toContain(
      "changed",
    );
  });

  test("ignores an expired grant", async () => {
    const now = Date.now();
    const report = await runDoctor(
      ready({
        now: () => now + 2 * HOUR,
        readState: async () => readyState(now),
      }),
    );

    expect(statusOf(report, "grants")).toBe("attention");
  });

  test("blocks a driver that will not start", async () => {
    const report = await runDoctor(
      ready({
        openDriver: async () => {
          throw new DriverError("Could not start the computer-use driver: spawn failed");
        },
      }),
    );

    expect(report.exitCode).toBe(2);
    expect(statusOf(report, "start")).toBe("blocked");
  });

  test("names the permissions to grant when the driver cannot read the desktop", async () => {
    const driver = new FakeDriver([mailApp()]);
    driver.listApps = async () => {
      throw new DriverError("Accessibility permission not granted");
    };

    const report = await runDoctor(ready({ openDriver: async () => driver }));

    const read = report.checks.find((check) => check.name === "read");
    expect(report.exitCode).toBe(1);
    expect(read?.status).toBe("attention");
    expect(read?.detail).toContain("Privacy & Security");
    expect(driver.closes).toBe(1);
  });

  test("includes the driver's own report when it has one", async () => {
    const report = await runDoctor(
      ready({ runDriverDoctor: async () => "all permissions granted" }),
    );

    expect(report.driverReport).toBe("all permissions granted");
  });
});

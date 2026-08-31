import { describe, expect, it } from "bun:test";
import { explainDaemonTokenProvisionFailure } from "./token";

describe("explaining why the daemon token could not be provisioned", () => {
  it("always leads with the fix that works regardless of platform or cause", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const message = explainDaemonTokenProvisionFailure(
        { ok: false, reason: "no-keyring" },
        platform,
      );
      expect(message).toContain("JAZZ_DAEMON_TOKEN=$(openssl rand -hex 24)");
      // Not just present — first. A long diagnosis before the fix buries the one line that
      // actually matters, exactly what the doc comment above the function promises it won't.
      const fixIndex = message.indexOf("export JAZZ_DAEMON_TOKEN");
      const diagnosisIndex = message.indexOf("keyring");
      expect(fixIndex).toBeGreaterThanOrEqual(0);
      expect(fixIndex).toBeLessThan(diagnosisIndex);
    }
  });

  it("explains the Linux case as the normal, expected state for a headless server", () => {
    const message = explainDaemonTokenProvisionFailure(
      { ok: false, reason: "no-keyring" },
      "linux",
    );
    expect(message).toContain("normal for a headless server");
    expect(message).toContain("D-Bus");
  });

  it("explains the macOS case as unusual, since Keychain is normally available", () => {
    const message = explainDaemonTokenProvisionFailure(
      { ok: false, reason: "no-keyring" },
      "darwin",
    );
    expect(message).toContain("unusual on macOS");
  });

  it("falls back to a platform-neutral explanation elsewhere", () => {
    const message = explainDaemonTokenProvisionFailure(
      { ok: false, reason: "no-keyring" },
      "win32",
    );
    expect(message).toContain("no keyring backend exists for this platform yet");
  });

  it("gives a different explanation when a keyring exists but the write failed, fix still first", () => {
    const message = explainDaemonTokenProvisionFailure(
      { ok: false, reason: "keyring-write-failed" },
      "darwin",
    );
    expect(message).toContain("locked");
    expect(message).not.toContain("headless server");
    expect(message.indexOf("export JAZZ_DAEMON_TOKEN")).toBeLessThan(message.indexOf("locked"));
  });
});

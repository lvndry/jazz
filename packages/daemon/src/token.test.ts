import { describe, expect, it } from "bun:test";
import { explainDaemonTokenProvisionFailure } from "./token";

describe("explaining why the daemon token could not be provisioned", () => {
  it("always leads with the fix that works regardless of cause", () => {
    for (const reason of ["no-keyring", "keyring-write-failed"] as const) {
      const message = explainDaemonTokenProvisionFailure({ ok: false, reason });
      expect(message).toContain("JAZZ_DAEMON_TOKEN=$(openssl rand -hex 24)");
      // Not just present — first. A long diagnosis before the fix buries the one line that
      // actually matters, exactly what the doc comment above the function promises it won't.
      const fixIndex = message.indexOf("export JAZZ_DAEMON_TOKEN");
      const diagnosisIndex = message.lastIndexOf("(");
      expect(fixIndex).toBeGreaterThanOrEqual(0);
      expect(fixIndex).toBeLessThan(diagnosisIndex);
    }
  });

  it("attributes 'no-keyring' to the explicit opt-out, not a missing OS keyring", () => {
    // detectKeyringBackend() falls through to a $JAZZ_HOME/secrets.json file whenever no real
    // OS keyring is reachable — the only way to still get "no-keyring" is having set
    // $JAZZ_DISABLE_KEYRING deliberately, so that's the only explanation left to give.
    const message = explainDaemonTokenProvisionFailure({ ok: false, reason: "no-keyring" });
    expect(message).toContain("JAZZ_DISABLE_KEYRING");
    expect(message).not.toContain("headless server");
    expect(message).not.toContain("D-Bus");
  });

  it("attributes 'keyring-write-failed' to both storage paths being unwritable", () => {
    const message = explainDaemonTokenProvisionFailure({
      ok: false,
      reason: "keyring-write-failed",
    });
    expect(message).toContain("JAZZ_HOME/secrets.json");
    expect(message).not.toContain("JAZZ_DISABLE_KEYRING");
  });
});

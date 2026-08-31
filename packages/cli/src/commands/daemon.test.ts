import { describe, expect, it } from "bun:test";
import { formatDaemonTokenProvisionFailure } from "./daemon";

describe("daemon token-provisioning failures", () => {
  it("directs headless peer servers to the persistent-service installer", () => {
    const message = formatDaemonTokenProvisionFailure(
      { ok: false, reason: "no-keyring" },
      { peerAgent: "bob", host: "100.101.102.103", port: 4748 },
    );

    expect(message).toContain("export JAZZ_DAEMON_TOKEN=$(openssl rand -hex 24)");
    expect(message).toContain(
      "sudo -E jazz daemon install --serve-peers bob --host 100.101.102.103 --port 4748",
    );
  });

  it("does not recommend peer-service installation when peer serving is disabled", () => {
    const message = formatDaemonTokenProvisionFailure(
      { ok: false, reason: "no-keyring" },
      { host: "100.101.102.103", port: 4748 },
    );

    expect(message).not.toContain("daemon install");
  });
});

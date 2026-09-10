import { describe, expect, it } from "bun:test";
import { decideDaemonToken, formatDaemonTokenProvisionFailure } from "./daemon";

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

describe("what a daemon serves behind", () => {
  it("serves behind a freshly generated token, and shows it once", () => {
    // Loopback gets a token now too — nothing but a credential separates a loopback daemon
    // from every other local user account — so the generated value has to reach the operator.
    const decision = decideDaemonToken({
      ok: true,
      token: "abc123",
      generated: true,
      backend: "macos",
    });

    expect(decision.token).toBe("abc123");
    expect(decision.notice).toContain("abc123");
    expect(decision.notice).toContain("set-token");
  });

  it("says nothing about a token it merely found", () => {
    // A supervisor restarting this daemon would otherwise write the secret into its logs on
    // every start.
    const decision = decideDaemonToken({ ok: true, token: "abc123", generated: false });

    expect(decision.token).toBe("abc123");
    expect(decision.notice).toBeUndefined();
  });

  it("serves open rather than refusing when nothing can store a token, and says so", () => {
    // Only reachable on loopback: `daemonCommand` exits on a non-loopback bind before asking
    // for a decision at all. Exiting here too would turn an unavailable keyring into "jazz
    // does not run on this machine".
    const decision = decideDaemonToken({ ok: false, reason: "no-keyring" });

    expect(decision.token).toBeUndefined();
    expect(decision.notice).toContain("no credential");
    expect(decision.notice).toContain("JAZZ_DISABLE_KEYRING");
  });
});

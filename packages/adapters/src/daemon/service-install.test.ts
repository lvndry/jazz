import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  installedUnitPath,
  reRunWithSudoCommand,
  type ServiceInstallOptions,
} from "./service-install";

const OPTIONS: ServiceInstallOptions = {
  agentId: "bob",
  host: "100.101.102.103",
  port: 4747,
  token: "s3cret-token",
  invocation: ["/home/bob/.local/bin/jazz"],
};

describe("the systemd unit", () => {
  it("points at the daemon command with the resolved invocation and options", () => {
    const unit = buildSystemdUnit(OPTIONS);
    expect(unit).toContain(
      "ExecStart='/home/bob/.local/bin/jazz' 'daemon' '--serve-peers' 'bob' " +
        "'--host' '100.101.102.103' '--port' '4747'",
    );
  });

  it("sources the token from a separate env file, never inline", () => {
    const unit = buildSystemdUnit(OPTIONS);
    expect(unit).toContain("EnvironmentFile=/etc/jazz/daemon.env");
    expect(unit).not.toContain(OPTIONS.token);
  });

  it("restarts on failure and enables at boot, not just this session", () => {
    const unit = buildSystemdUnit(OPTIONS);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});

describe("the launchd plist", () => {
  it("wraps the invocation to source the env file before exec, since launchd has no EnvironmentFile=", () => {
    const plistXml = buildLaunchdPlist(OPTIONS);
    expect(plistXml).toContain("source '/etc/jazz/daemon.env'");
    expect(plistXml).toContain("'/home/bob/.local/bin/jazz'");
    expect(plistXml).toContain("'--serve-peers'");
    expect(plistXml).toContain("'bob'");
  });

  it("never puts the token inline", () => {
    expect(buildLaunchdPlist(OPTIONS)).not.toContain(OPTIONS.token);
  });

  it("runs at load and restarts if it dies — a persistent service, not a one-shot", () => {
    const plistXml = buildLaunchdPlist(OPTIONS);
    expect(plistXml).toContain("<key>RunAtLoad</key>");
    expect(plistXml).toContain("<key>KeepAlive</key>");
  });
});

describe("installedUnitPath", () => {
  it("names the right file for each init system, and nothing for unsupported", () => {
    expect(installedUnitPath("systemd")).toBe("/etc/systemd/system/jazz-daemon.service");
    expect(installedUnitPath("launchd")).toBe("/Library/LaunchDaemons/com.jazz.daemon.plist");
    expect(installedUnitPath("unsupported")).toBeUndefined();
  });
});

describe("the re-run-with-sudo hint", () => {
  const originalArgv = process.argv;
  beforeEach(() => {
    process.argv = ["/usr/bin/jazz", "daemon", "install", "--serve-peers", "bob"];
  });
  afterEach(() => {
    process.argv = originalArgv;
  });

  it("reconstructs exactly what the operator typed, minus the interpreter, prefixed with sudo", () => {
    expect(reRunWithSudoCommand()).toBe("sudo 'daemon' 'install' '--serve-peers' 'bob'");
  });
});

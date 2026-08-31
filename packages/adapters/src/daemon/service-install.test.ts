import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  installedUnitPath,
  isSafeToken,
  reRunWithSudoCommand,
  resolveInvokingUser,
  type ServiceInstallOptions,
  waitForDaemonHealthy,
} from "./service-install";

const OPTIONS: ServiceInstallOptions = {
  agentId: "bob",
  host: "100.101.102.103",
  port: 4747,
  token: "s3cret-token",
  invocation: ["/home/bob/.local/bin/jazz"],
  user: { username: "bob", home: "/home/bob" },
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

  it("never runs as root — the invoking user's identity and JAZZ_HOME are wired in", () => {
    const unit = buildSystemdUnit(OPTIONS);
    expect(unit).toContain("User=bob");
    expect(unit).toContain("Environment=JAZZ_HOME=/home/bob/.jazz");
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

  it("never runs as root — UserName and JAZZ_HOME are wired in", () => {
    const plistXml = buildLaunchdPlist(OPTIONS);
    expect(plistXml).toContain("<key>UserName</key>\n    <string>bob</string>");
    expect(plistXml).toContain("<key>JAZZ_HOME</key>\n      <string>/home/bob/.jazz</string>");
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

  it("keeps the jazz binary itself — argv[0] is not an interpreter to discard for a compiled binary", () => {
    expect(reRunWithSudoCommand(["/home/bob/.local/bin/jazz"])).toBe(
      "sudo '/home/bob/.local/bin/jazz' 'daemon' 'install' '--serve-peers' 'bob'",
    );
  });

  it("uses whatever invocation prefix was actually resolved, not a hardcoded path", () => {
    expect(reRunWithSudoCommand(["npx", "--yes", "jazz-ai"])).toBe(
      "sudo 'npx' '--yes' 'jazz-ai' 'daemon' 'install' '--serve-peers' 'bob'",
    );
  });
});

describe("token safety", () => {
  it("accepts a generated hex token", () => {
    expect(isSafeToken("a0d85fdf7467edc9d8c1535e1ec56808080d32e5b7de3c6e")).toBe(true);
  });

  it("rejects anything that could break an env-file line or run as a shell command", () => {
    expect(isSafeToken("token\nJAZZ_EVIL=1")).toBe(false);
    expect(isSafeToken("token; rm -rf /")).toBe(false);
    expect(isSafeToken("token`whoami`")).toBe(false);
    expect(isSafeToken("token$(whoami)")).toBe(false);
    expect(isSafeToken("token with spaces")).toBe(false);
    expect(isSafeToken("")).toBe(false);
  });
});

describe("waiting for the daemon to prove it is reachable", () => {
  it("succeeds once something answers 200 on /health", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        return url.pathname === "/health"
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await Effect.runPromise(
        Effect.either(
          waitForDaemonHealthy({ host: "127.0.0.1", port: server.port }, "systemd", 2_000),
        ),
      );
      expect(result._tag).toBe("Right");
    } finally {
      server.stop(true);
    }
  });

  it("fails with a diagnostic command when nothing is listening — a crashed unit, not a slow one", async () => {
    // An arbitrary unused port: nothing is bound here, simulating an ExecStart that crashed
    // immediately after `systemctl restart` still reported success.
    const unusedPort = 41287;
    const result = await Effect.runPromise(
      Effect.either(waitForDaemonHealthy({ host: "127.0.0.1", port: unusedPort }, "systemd", 500)),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("journalctl -u jazz-daemon");
    }
  });

  it("treats 0.0.0.0 as a bind address, probing loopback as the destination instead", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "0.0.0.0",
      fetch: (request) => {
        const url = new URL(request.url);
        return url.pathname === "/health"
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response("not found", { status: 404 });
      },
    });
    try {
      const result = await Effect.runPromise(
        Effect.either(
          waitForDaemonHealthy({ host: "0.0.0.0", port: server.port }, "launchd", 2_000),
        ),
      );
      expect(result._tag).toBe("Right");
    } finally {
      server.stop(true);
    }
  });
});

describe("resolving who to run the service as", () => {
  const originalSudoUser = process.env["SUDO_USER"];
  afterEach(() => {
    if (originalSudoUser === undefined) delete process.env["SUDO_USER"];
    else process.env["SUDO_USER"] = originalSudoUser;
  });

  it("refuses when $SUDO_USER is absent — there is no non-root identity to preserve", async () => {
    delete process.env["SUDO_USER"];
    const result = await Effect.runPromise(Effect.either(resolveInvokingUser()));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left.message).toContain("SUDO_USER");
    }
  });

  it("refuses a SUDO_USER containing characters unsafe to place after a shell tilde", async () => {
    process.env["SUDO_USER"] = "bob; rm -rf /";
    const result = await Effect.runPromise(Effect.either(resolveInvokingUser()));
    expect(result._tag).toBe("Left");
  });

  it("resolves the real invoking user's actual home directory", async () => {
    const realUsername = os.userInfo().username;
    process.env["SUDO_USER"] = realUsername;
    const result = await Effect.runPromise(Effect.either(resolveInvokingUser()));
    expect(result._tag).toBe("Right");
    if (result._tag === "Right") {
      expect(result.right.username).toBe(realUsername);
      expect(result.right.home).toBe(os.homedir());
    }
  });
});

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createSandbox, osSandboxActive, removeSandbox, sandboxedArgv } from "./sandbox";

function shell(environment: Readonly<Record<string, string>>, script: string) {
  const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
    env: { ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("sample sandbox", () => {
  it("points HOME, JAZZ_HOME, TMPDIR at the sample and schedules in-process", () => {
    const sandbox = createSandbox("sandbox-test");
    try {
      expect(sandbox.environment["HOME"]).toBe(sandbox.home);
      expect(sandbox.environment["JAZZ_HOME"]).toBe(join(sandbox.home, ".jazz"));
      expect(sandbox.environment["TMPDIR"]?.startsWith(sandbox.root)).toBe(true);
      expect(sandbox.environment["JAZZ_SCHEDULER"]).toBe("in-process");
      expect(sandbox.environment["PATH"]).not.toContain("/opt/homebrew");
    } finally {
      removeSandbox(sandbox);
    }
  });

  it("runs stub commands from PATH, logs every call, and keeps the network off", () => {
    const sandbox = createSandbox("sandbox-test", ["himalaya"]);
    try {
      writeFileSync(
        join(sandbox.stubRoot, "data", "mail.json"),
        JSON.stringify({
          accounts: ["personal"],
          mailboxes: {
            INBOX: [
              {
                id: "1",
                from: { name: "Landlord", addr: "landlord@example.com" },
                to: "me@ourco.com",
                subject: "Rent",
                date: "2026-09-20T10:00:00Z",
                flags: [],
                body: "Rent is due.",
              },
            ],
          },
          outbox: [],
          nextId: 2,
        }),
      );

      const listed = shell(sandbox.environment, "himalaya envelope list -m INBOX --json");
      const network = shell(sandbox.environment, "curl -s https://example.com");

      expect(JSON.parse(listed.stdout)).toMatchObject({
        envelopes: [{ id: "1", subject: "Rent" }],
      });
      expect(network.exitCode).toBe(6);
      const calls = readFileSync(join(sandbox.stubRoot, "invocations.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { command: string; args: string[] });
      expect(calls.map((call) => call.command)).toEqual(["himalaya", "curl"]);
    } finally {
      removeSandbox(sandbox);
    }
  });

  /**
   * The regression: a sample ran `/bin/launchctl` by absolute path, which a closed PATH
   * cannot stop, and registered a real LaunchAgent in the user's session.
   */
  it.skipIf(!osSandboxActive())(
    "blocks forbidden binaries by absolute path and writes to the real home",
    () => {
      const sandbox = createSandbox("sandbox-test");
      try {
        const probe = join(homedir(), `.jazz-eval-sandbox-probe-${process.pid}`);
        const argv = sandboxedArgv(
          [
            "/bin/sh",
            "-c",
            `/bin/launchctl list >/dev/null 2>&1; echo launchctl=$?; touch "${probe}" 2>/dev/null; echo home=$?; touch "${sandbox.tmp}/ok" && echo tmp=0`,
          ],
          sandbox.environment,
        );
        const proc = Bun.spawnSync(argv, { env: { ...sandbox.environment }, stdout: "pipe" });
        const output = proc.stdout.toString();
        expect(output).toContain("launchctl=126");
        expect(output).toContain("home=1");
        expect(output).toContain("tmp=0");
      } finally {
        removeSandbox(sandbox);
      }
    },
  );
});

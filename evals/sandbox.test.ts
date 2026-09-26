import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { createSandbox, removeSandbox } from "./sandbox";

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
});

/** Boundary tests for the SSH host adapter using a fake SSH executable. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostProfile } from "@jazz/core/types/host";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { probeRemoteHost, probeRemoteProvider, transferRemoteSecret } from "./remote-host";

const host: HostProfile = {
  name: "nightbox",
  sshTarget: "nightbox",
  workspacePath: "/home/jazz/work",
};

describe("remote host SSH boundary", () => {
  let directory: string;
  let oldPath: string | undefined;
  let oldCapture: string | undefined;
  let oldResponse: string | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "jazz-detach-ssh-"));
    oldPath = process.env["PATH"];
    oldCapture = process.env["JAZZ_TEST_CAPTURE"];
    oldResponse = process.env["JAZZ_TEST_RESPONSE"];
    const executable = join(directory, "ssh");
    writeFileSync(
      executable,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$JAZZ_TEST_CAPTURE.args"\ncat > "$JAZZ_TEST_CAPTURE.stdin"\nprintf \'%s\\n\' "$JAZZ_TEST_RESPONSE"\n',
    );
    chmodSync(executable, 0o755);
    process.env["PATH"] = `${directory}:${oldPath ?? ""}`;
    process.env["JAZZ_TEST_CAPTURE"] = join(directory, "capture");
  });

  afterEach(() => {
    if (oldPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = oldPath;
    if (oldCapture === undefined) delete process.env["JAZZ_TEST_CAPTURE"];
    else process.env["JAZZ_TEST_CAPTURE"] = oldCapture;
    if (oldResponse === undefined) delete process.env["JAZZ_TEST_RESPONSE"];
    else process.env["JAZZ_TEST_RESPONSE"] = oldResponse;
    rmSync(directory, { recursive: true, force: true });
  });

  it("requires pinned host identity and reports machine readiness", async () => {
    process.env["JAZZ_TEST_RESPONSE"] = "Linux\nx86_64\nglibc\n1048576\n0.15.6\nhealthy\nlocal";
    const probe = await probeRemoteHost(host);
    expect(probe).toEqual({
      os: "Linux",
      arch: "x64",
      libc: "glibc",
      availableBytes: 1024 * 1024 * 1024,
      jazzVersion: "0.15.6",
      daemonHealthy: true,
      localJazzPresent: true,
    });
    const args = readFileSync(join(directory, "capture.args"), "utf8");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args).toContain("BatchMode=yes");
  });

  it("transfers a selected key on stdin, never in arguments", async () => {
    process.env["JAZZ_TEST_RESPONSE"] = "stored";
    await transferRemoteSecret(host, "llm.openai.api_key", "very-private-value");
    expect(readFileSync(join(directory, "capture.stdin"), "utf8")).toBe("very-private-value");
    expect(readFileSync(join(directory, "capture.args"), "utf8")).not.toContain(
      "very-private-value",
    );
  });

  it("rejects a command-shaped SSH target before spawning", async () => {
    await expect(probeRemoteHost({ ...host, sshTarget: "nightbox;touch /tmp/x" })).rejects.toThrow(
      "SSH target",
    );
  });

  it("checks provider reachability through a fixed origin", async () => {
    process.env["JAZZ_TEST_RESPONSE"] = "";
    await probeRemoteProvider(host, "openai");
    expect(readFileSync(join(directory, "capture.args"), "utf8")).toContain(
      "https://api.openai.com",
    );
    await expect(probeRemoteProvider(host, "ollama")).rejects.toThrow("unsupported");
  });
});

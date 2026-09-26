import { describe, expect, it } from "bun:test";
import { daemonPidPath, probeDaemonOwner } from "./daemon-process";

describe("daemonPidPath", () => {
  it("scopes the pidfile to the port under JAZZ_HOME", () => {
    const previous = process.env["JAZZ_HOME"];
    process.env["JAZZ_HOME"] = "/tmp/jazz-home-test";
    try {
      expect(daemonPidPath(4747)).toBe("/tmp/jazz-home-test/daemon-4747.pid");
    } finally {
      if (previous === undefined) delete process.env["JAZZ_HOME"];
      else process.env["JAZZ_HOME"] = previous;
    }
  });
});

describe("probeDaemonOwner", () => {
  function serveHealth(body: unknown): { readonly port: number; readonly stop: () => void } {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(body) });
    const port = server.port;
    if (port === undefined) {
      throw new Error("the test server has no port");
    }
    return { port, stop: () => void server.stop(true) };
  }

  it("reads the Jazz home a daemon reports serving", async () => {
    const server = serveHealth({ ok: true, owner: "home-a" });
    try {
      expect(await probeDaemonOwner("127.0.0.1", server.port, 1_000)).toBe("home-a");
    } finally {
      server.stop();
    }
  });

  it("tells an older daemon without an owner apart from nothing listening", async () => {
    const server = serveHealth({ ok: true });
    const port = server.port;
    try {
      expect(await probeDaemonOwner("127.0.0.1", port, 1_000)).toBe("");
    } finally {
      server.stop();
    }
    expect(await probeDaemonOwner("127.0.0.1", port, 300)).toBeUndefined();
  });
});

import { describe, expect, it } from "bun:test";
import { daemonPidPath } from "./daemon-process";

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

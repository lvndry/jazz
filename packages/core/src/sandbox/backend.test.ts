import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { findExecutable, interpretProbe, probeConfinement, type ProbeRunner } from "./backend";

const confinedRunner: ProbeRunner = () => ({ status: 0, stderr: "" });

describe("interpretProbe", () => {
  test("is confined only when the script passed and no outside file appeared", () => {
    expect(interpretProbe({ status: 0, stderr: "" }, false)).toEqual({ confined: true });
  });

  test("rejects a backend that let the outside write land", () => {
    const byStatus = interpretProbe({ status: 11, stderr: "" }, false);
    const byFile = interpretProbe({ status: 0, stderr: "" }, true);
    expect(byStatus.confined).toBe(false);
    expect(byFile.confined).toBe(false);
  });

  test("rejects a backend that blocks its own writable root", () => {
    const verdict = interpretProbe({ status: 10, stderr: "" }, false);
    expect(verdict.confined === false && verdict.reason).toContain("inside its own writable root");
  });

  test("reports the launcher's first stderr line for any other failure", () => {
    const verdict = interpretProbe(
      { status: 1, stderr: "bwrap: No permissions to create new namespace\nmore" },
      false,
    );
    expect(verdict.confined === false && verdict.reason).toContain(
      "No permissions to create new namespace",
    );
  });

  test("reports a spawn error", () => {
    const verdict = interpretProbe({ status: null, stderr: "", spawnError: "ENOENT" }, false);
    expect(verdict.confined === false && verdict.reason).toContain("ENOENT");
  });
});

describe("probeConfinement", () => {
  test("darwin with a working sandbox-exec is full seatbelt", () => {
    const status = probeConfinement({
      platform: "darwin",
      searchPath: "",
      runner: confinedRunner,
      sandboxExecExists: true,
    });
    expect(status).toEqual({ level: "full", backend: "seatbelt" });
  });

  test("darwin without sandbox-exec is none with a remedy", () => {
    const status = probeConfinement({
      platform: "darwin",
      searchPath: "",
      runner: confinedRunner,
      sandboxExecExists: false,
    });
    expect(status.level).toBe("none");
    expect(status.remedy).toContain("shell.confinement");
  });

  test("darwin whose backend does not deny writes is none", () => {
    const status = probeConfinement({
      platform: "darwin",
      searchPath: "",
      runner: () => ({ status: 11, stderr: "" }),
      sandboxExecExists: true,
    });
    expect(status.level).toBe("none");
    expect(status.reason).toContain("did not deny");
  });

  test("windows and other platforms are none", () => {
    const status = probeConfinement({ platform: "win32", searchPath: "" });
    expect(status.level).toBe("none");
    expect(status.backend).toBe("none");
    expect(status.reason).toContain("win32");
  });

  describe("linux", () => {
    let directory: string;
    function withFakeBwrap(run: (searchPath: string) => void): void {
      directory = mkdtempSync(path.join(os.tmpdir(), "jazz-fake-bwrap-"));
      try {
        const binary = path.join(directory, "bwrap");
        writeFileSync(binary, "#!/bin/sh\n");
        chmodSync(binary, 0o755);
        run(directory);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    test("is none with an install remedy when bwrap is missing", () => {
      const status = probeConfinement({ platform: "linux", searchPath: "/nonexistent" });
      expect(status.level).toBe("none");
      expect(status.remedy).toContain("bubblewrap");
    });

    test("is full when a private /dev works", () => {
      withFakeBwrap((searchPath) => {
        const status = probeConfinement({ platform: "linux", searchPath, runner: confinedRunner });
        expect(status.level).toBe("full");
        expect(status.devices).toBe("minimal");
      });
    });

    test("is partial when only the host /dev works", () => {
      withFakeBwrap((searchPath) => {
        const runner: ProbeRunner = (argv) =>
          argv.includes("--dev-bind")
            ? { status: 0, stderr: "" }
            : { status: 1, stderr: "bwrap: mount devtmpfs" };
        const status = probeConfinement({ platform: "linux", searchPath, runner });
        expect(status.level).toBe("partial");
        expect(status.devices).toBe("host");
        expect(status.reason).toContain("/dev");
      });
    });

    test("is none when bwrap is installed but cannot run", () => {
      withFakeBwrap((searchPath) => {
        const status = probeConfinement({
          platform: "linux",
          searchPath,
          runner: () => ({ status: 1, stderr: "bwrap: No permissions to create new namespace" }),
        });
        expect(status.level).toBe("none");
        expect(status.reason).toContain("unusable");
      });
    });
  });
});

describe("findExecutable", () => {
  test("returns undefined for an empty or missing search path", () => {
    expect(findExecutable("definitely-not-a-binary", undefined)).toBeUndefined();
    expect(findExecutable("definitely-not-a-binary", "")).toBeUndefined();
  });
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { interpretProbe, probeConfinement, TRUSTED_BWRAP_PATHS, type ProbeRunner } from "./backend";

/** Stands in for a backend that really ran the probe: the inside write lands, the outside is denied. */
const confinedRunner: ProbeRunner = (argv) => {
  const insideRoot = argv[argv.length - 2] ?? "";
  writeFileSync(path.join(insideRoot, "inside"), "probe\n");
  return { status: 0, stderr: "" };
};

/** A launcher that exits 0 without running anything, as a planted fake would. */
const fakeLauncherRunner: ProbeRunner = () => ({ status: 0, stderr: "" });

const landedInside = { inside: true, outside: false };

describe("interpretProbe", () => {
  test("is confined only when the inside write landed and the outside one did not", () => {
    expect(interpretProbe({ status: 0, stderr: "" }, landedInside)).toEqual({ confined: true });
  });

  test("rejects a launcher that exits 0 without running the probe", () => {
    const verdict = interpretProbe({ status: 0, stderr: "" }, { inside: false, outside: false });
    expect(verdict.confined === false && verdict.reason).toContain("without running the probe");
  });

  test("rejects a backend that let the outside write land", () => {
    const byStatus = interpretProbe({ status: 11, stderr: "" }, landedInside);
    const byFile = interpretProbe({ status: 0, stderr: "" }, { inside: true, outside: true });
    expect(byStatus.confined).toBe(false);
    expect(byFile.confined).toBe(false);
  });

  test("rejects a backend that blocks its own writable root", () => {
    const verdict = interpretProbe({ status: 10, stderr: "" }, { inside: false, outside: false });
    expect(verdict.confined === false && verdict.reason).toContain("inside its own writable root");
  });

  test("reports the launcher's first stderr line for any other failure", () => {
    const verdict = interpretProbe(
      { status: 1, stderr: "bwrap: No permissions to create new namespace\nmore" },
      { inside: false, outside: false },
    );
    expect(verdict.confined === false && verdict.reason).toContain(
      "No permissions to create new namespace",
    );
  });

  test("reports a spawn error", () => {
    const verdict = interpretProbe(
      { status: null, stderr: "", spawnError: "ENOENT" },
      { inside: false, outside: false },
    );
    expect(verdict.confined === false && verdict.reason).toContain("ENOENT");
  });
});

describe("probeConfinement", () => {
  test("darwin with a working sandbox-exec is full seatbelt", () => {
    const status = probeConfinement({
      platform: "darwin",
      runner: confinedRunner,
      sandboxExecExists: true,
    });
    expect(status).toEqual({ level: "full", backend: "seatbelt" });
  });

  test("darwin without sandbox-exec is none with a remedy", () => {
    const status = probeConfinement({
      platform: "darwin",
      runner: confinedRunner,
      sandboxExecExists: false,
    });
    expect(status.level).toBe("none");
    expect(status.remedy).toContain("shell.confinement");
  });

  test("darwin whose backend does not deny writes is none", () => {
    const status = probeConfinement({
      platform: "darwin",
      runner: (argv) => {
        confinedRunner(argv);
        return { status: 11, stderr: "" };
      },
      sandboxExecExists: true,
    });
    expect(status.level).toBe("none");
    expect(status.reason).toContain("did not deny");
  });

  test("darwin with a launcher that exits 0 without running anything is none", () => {
    const status = probeConfinement({
      platform: "darwin",
      runner: fakeLauncherRunner,
      sandboxExecExists: true,
    });
    expect(status.level).toBe("none");
  });

  test("windows and other platforms are none", () => {
    const status = probeConfinement({ platform: "win32" });
    expect(status.level).toBe("none");
    expect(status.backend).toBe("none");
    expect(status.reason).toContain("win32");
  });

  describe("linux", () => {
    function withFakeBwrap(run: (candidates: readonly string[]) => void): void {
      const directory = mkdtempSync(path.join(os.tmpdir(), "jazz-fake-bwrap-"));
      try {
        const binary = path.join(directory, "bwrap");
        writeFileSync(binary, "#!/bin/sh\n");
        chmodSync(binary, 0o755);
        run([binary]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    test("is none with an install remedy when bwrap is missing", () => {
      const status = probeConfinement({
        platform: "linux",
        bwrapCandidates: ["/nonexistent/bwrap"],
      });
      expect(status.level).toBe("none");
      expect(status.remedy).toContain("bubblewrap");
    });

    test("looks only in fixed system locations, never PATH", () => {
      expect(TRUSTED_BWRAP_PATHS.every((candidate) => path.isAbsolute(candidate))).toBe(true);
      expect(TRUSTED_BWRAP_PATHS.some((candidate) => candidate.includes("node_modules"))).toBe(
        false,
      );
    });

    test("is full when a private /dev works", () => {
      withFakeBwrap((bwrapCandidates) => {
        const status = probeConfinement({
          platform: "linux",
          bwrapCandidates,
          runner: confinedRunner,
        });
        expect(status.level).toBe("full");
        expect(status.devices).toBe("minimal");
      });
    });

    test("is partial when only the host /dev works", () => {
      withFakeBwrap((bwrapCandidates) => {
        const runner: ProbeRunner = (argv) =>
          argv.includes("--dev-bind")
            ? confinedRunner(argv)
            : { status: 1, stderr: "bwrap: mount devtmpfs" };
        const status = probeConfinement({ platform: "linux", bwrapCandidates, runner });
        expect(status.level).toBe("partial");
        expect(status.devices).toBe("host");
        expect(status.reason).toContain("/dev");
      });
    });

    test("rejects a fake bwrap that exits 0 without running the probe", () => {
      withFakeBwrap((bwrapCandidates) => {
        const status = probeConfinement({
          platform: "linux",
          bwrapCandidates,
          runner: fakeLauncherRunner,
        });
        expect(status.level).toBe("none");
        expect(status.backend).toBe("none");
      });
    });

    test("is none when bwrap is installed but cannot run", () => {
      withFakeBwrap((bwrapCandidates) => {
        const status = probeConfinement({
          platform: "linux",
          bwrapCandidates,
          runner: () => ({ status: 1, stderr: "bwrap: No permissions to create new namespace" }),
        });
        expect(status.level).toBe("none");
        expect(status.reason).toContain("unusable");
      });
    });
  });
});

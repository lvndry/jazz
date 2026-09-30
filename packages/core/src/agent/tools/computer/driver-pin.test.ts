import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  checkDriverPin,
  computerUseSupported,
  DRIVER_COMMAND,
  DRIVER_MISSING_MESSAGE,
  DRIVER_PATH_ENV,
  hashFileSha256,
  NOT_ACKNOWLEDGED_MESSAGE,
  resolveDriverExecutable,
} from "./driver-pin";

function executableIn(directory: string, name: string, content: string): string {
  const file = path.join(directory, name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
}

function scratchDirectory(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "driver-pin-")));
}

describe("computerUseSupported", () => {
  test("is macOS on Apple Silicon only", () => {
    expect(computerUseSupported("darwin", "arm64")).toBe(true);
    expect(computerUseSupported("darwin", "x64")).toBe(false);
    expect(computerUseSupported("linux", "arm64")).toBe(false);
    expect(computerUseSupported("win32", "x64")).toBe(false);
  });
});

describe("resolveDriverExecutable", () => {
  test("takes the configured path before searching PATH", async () => {
    const directory = scratchDirectory();
    const configured = executableIn(directory, "custom-driver", "#!/bin/sh\n");
    const onPath = scratchDirectory();
    executableIn(onPath, DRIVER_COMMAND, "#!/bin/sh\n");

    expect(await resolveDriverExecutable({ [DRIVER_PATH_ENV]: configured, PATH: onPath })).toBe(
      configured,
    );
  });

  test("finds the driver on PATH", async () => {
    const onPath = scratchDirectory();
    const driver = executableIn(onPath, DRIVER_COMMAND, "#!/bin/sh\n");

    expect(await resolveDriverExecutable({ PATH: onPath })).toBe(driver);
  });

  test("resolves a symlink to the real file, so the hash is of what runs", async () => {
    const directory = scratchDirectory();
    const real = executableIn(directory, "real-driver", "#!/bin/sh\n");
    const linkDirectory = scratchDirectory();
    await Bun.$`ln -s ${real} ${path.join(linkDirectory, DRIVER_COMMAND)}`;

    expect(await resolveDriverExecutable({ PATH: linkDirectory })).toBe(real);
  });

  test("finds nothing when the configured path is not an executable file", async () => {
    expect(
      await resolveDriverExecutable({ [DRIVER_PATH_ENV]: "/nonexistent/driver", PATH: "" }),
    ).toBeUndefined();
  });
});

describe("hashFileSha256", () => {
  test("is the SHA-256 of the file's bytes", async () => {
    const directory = scratchDirectory();
    const file = executableIn(directory, "driver", "driver bytes");

    expect(await hashFileSha256(file)).toBe(
      createHash("sha256").update("driver bytes").digest("hex"),
    );
  });
});

describe("checkDriverPin", () => {
  function acknowledgement(file: string, content: string) {
    return {
      acknowledgedAt: 1,
      driverPath: file,
      driverSha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  test("refuses when computer use was never acknowledged", async () => {
    const check = await checkDriverPin(undefined, {});
    expect(check).toEqual({ ok: false, reason: NOT_ACKNOWLEDGED_MESSAGE });
  });

  test("refuses when the driver is gone", async () => {
    const check = await checkDriverPin(acknowledgement("/x", "a"), { PATH: "" });
    expect(check).toEqual({ ok: false, reason: DRIVER_MISSING_MESSAGE });
  });

  test("accepts the acknowledged build", async () => {
    const directory = scratchDirectory();
    const file = executableIn(directory, DRIVER_COMMAND, "build one");

    const check = await checkDriverPin(acknowledgement(file, "build one"), { PATH: directory });

    expect(check).toMatchObject({ ok: true, executablePath: file });
  });

  test("refuses a driver that changed since it was acknowledged", async () => {
    const directory = scratchDirectory();
    const file = executableIn(directory, DRIVER_COMMAND, "build two");

    const check = await checkDriverPin(acknowledgement(file, "build one"), { PATH: directory });

    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("changed since you acknowledged it");
  });
});

import { describe, expect, test } from "bun:test";
import {
  SANDBOX_EXEC_PATH,
  SEATBELT_WRITABLE_DEVICES,
  bwrapArgv,
  seatbeltArgv,
  seatbeltProfile,
} from "./launchers";

describe("seatbeltProfile", () => {
  test("denies all writes then re-allows devices and numbered roots", () => {
    const lines = seatbeltProfile(2).split("\n");
    expect(lines[0]).toBe("(version 1)");
    expect(lines[1]).toBe("(allow default)");
    expect(lines[2]).toBe("(deny file-write*)");
    const allow = lines[3] ?? "";
    for (const device of SEATBELT_WRITABLE_DEVICES) {
      expect(allow).toContain(`(literal "${device}")`);
    }
    expect(allow).toContain('(subpath (param "WRITABLE_ROOT_0"))');
    expect(allow).toContain('(subpath (param "WRITABLE_ROOT_1"))');
    expect(allow).not.toContain("WRITABLE_ROOT_2");
  });

  test("leaves reads and network on the default allow", () => {
    const profile = seatbeltProfile(1);
    expect(profile).not.toContain("file-read");
    expect(profile).not.toContain("network");
  });

  test("is the same text for the same root count", () => {
    expect(seatbeltProfile(3)).toBe(seatbeltProfile(3));
  });
});

describe("seatbeltArgv", () => {
  test("passes each root as a -D parameter and never as profile text", () => {
    const hostile = '/work/we"ird (path)\n(allow file-write* (subpath "/"))';
    const argv = seatbeltArgv({ roots: [hostile, "/plain"] }, ["sh", "-c", "true"]);
    expect(argv[0]).toBe(SANDBOX_EXEC_PATH);
    expect(argv).toContain(`WRITABLE_ROOT_0=${hostile}`);
    expect(argv).toContain("WRITABLE_ROOT_1=/plain");
    const profile = argv[argv.indexOf("-p") + 1] ?? "";
    expect(profile).not.toContain("weird");
    expect(profile).not.toContain(hostile);
    expect(profile.match(/allow file-write\*/g)).toHaveLength(1);
  });

  test("ends with the wrapped command untouched", () => {
    const argv = seatbeltArgv({ roots: ["/a"] }, ["sh", "-c", "echo $HOME"]);
    expect(argv.slice(-3)).toEqual(["sh", "-c", "echo $HOME"]);
  });
});

describe("bwrapArgv", () => {
  test("binds the tree read-only, roots read-write, and keeps network and pid space", () => {
    const argv = bwrapArgv(
      "/usr/bin/bwrap",
      { roots: ["/work", "/tmp"] },
      ["sh", "-c", "true"],
      "minimal",
    );
    expect(argv.slice(0, 4)).toEqual(["/usr/bin/bwrap", "--ro-bind", "/", "/"]);
    expect(argv).toContain("--die-with-parent");
    expect(argv.join(" ")).toContain("--bind /work /work --bind /tmp /tmp");
    expect(argv.join(" ")).toContain("--dev /dev");
    expect(argv.some((argument) => argument.startsWith("--unshare"))).toBe(false);
    expect(argv.slice(-4)).toEqual(["--", "sh", "-c", "true"]);
  });

  test("binds the host /dev when the private one is unavailable", () => {
    const argv = bwrapArgv("/usr/bin/bwrap", { roots: [] }, ["true"], "host");
    expect(argv.join(" ")).toContain("--dev-bind /dev /dev");
    expect(argv.join(" ")).not.toContain("--dev /dev");
  });
});

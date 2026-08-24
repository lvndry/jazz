import { describe, expect, it } from "bun:test";
import { nativePackagesForTarget, readNativeVersions } from "./opentui-natives";

const AVAILABLE = [
  "@opentui/core-darwin-x64",
  "@opentui/core-darwin-arm64",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-win32-x64",
  "@opentui/core-win32-arm64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-linux-arm64-musl",
];

// The targets scripts/build.ts compiles for. A release matrix that cannot resolve one
// of these fails the whole job, which is what this mapping exists to prevent.
const COMPILE_TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-arm64",
  "bun-linux-x64",
  "bun-linux-arm64-musl",
  "bun-linux-x64-musl",
];

describe("nativePackagesForTarget", () => {
  it("resolves a native library for every target a release builds", () => {
    for (const target of COMPILE_TARGETS) {
      expect(nativePackagesForTarget(target, AVAILABLE).length).toBeGreaterThan(0);
    }
  });

  it("pulls both libc variants for linux, which bun does not prune by libc", () => {
    expect(nativePackagesForTarget("bun-linux-arm64", AVAILABLE)).toEqual([
      "@opentui/core-linux-arm64",
      "@opentui/core-linux-arm64-musl",
    ]);
    expect(nativePackagesForTarget("bun-linux-arm64-musl", AVAILABLE)).toEqual([
      "@opentui/core-linux-arm64",
      "@opentui/core-linux-arm64-musl",
    ]);
  });

  it("takes only the matching architecture, never a sibling", () => {
    expect(nativePackagesForTarget("bun-darwin-x64", AVAILABLE)).toEqual([
      "@opentui/core-darwin-x64",
    ]);
    expect(nativePackagesForTarget("bun-linux-x64", AVAILABLE)).not.toContain(
      "@opentui/core-linux-arm64",
    );
  });

  it("returns nothing for a triple it cannot read, rather than guessing", () => {
    expect(nativePackagesForTarget("bun", AVAILABLE)).toEqual([]);
    expect(nativePackagesForTarget("bun-freebsd-riscv64", AVAILABLE)).toEqual([]);
  });

  it("defaults to what the installed @opentui/core declares", () => {
    const declared = Object.keys(readNativeVersions());
    expect(declared).toContain(`@opentui/core-${process.platform}-${process.arch}`);
    expect(nativePackagesForTarget(`bun-${process.platform}-${process.arch}`)).toContain(
      `@opentui/core-${process.platform}-${process.arch}`,
    );
  });
});

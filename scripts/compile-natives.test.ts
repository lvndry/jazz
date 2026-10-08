import { describe, expect, it } from "bun:test";
import { flattenProviders, nativePackagesForTarget, readNativeVersions } from "./compile-natives";

// Two real providers: the fullscreen UI's native and the OG card renderer's.
// nativePackagesForTarget takes provider -> declared natives, as
// readNativeVersions() returns them.
const OPENTUI: Record<string, string> = {
  "@opentui/core-darwin-x64": "1.0.0",
  "@opentui/core-darwin-arm64": "1.0.0",
  "@opentui/core-linux-x64": "1.0.0",
  "@opentui/core-linux-arm64": "1.0.0",
  "@opentui/core-win32-x64": "1.0.0",
  "@opentui/core-win32-arm64": "1.0.0",
  "@opentui/core-linux-x64-musl": "1.0.0",
  "@opentui/core-linux-arm64-musl": "1.0.0",
};
const RESVG: Record<string, string> = {
  "@resvg/resvg-js-darwin-x64": "2.6.2",
  "@resvg/resvg-js-darwin-arm64": "2.6.2",
  "@resvg/resvg-js-linux-x64-gnu": "2.6.2",
  "@resvg/resvg-js-linux-x64-musl": "2.6.2",
  "@resvg/resvg-js-linux-arm64-gnu": "2.6.2",
  "@resvg/resvg-js-linux-arm64-musl": "2.6.2",
  "@resvg/resvg-js-win32-x64-msvc": "2.6.2",
};
const PROVIDERS = { "@opentui/core": OPENTUI, "@resvg/resvg-js": RESVG };

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
      expect(nativePackagesForTarget(target, PROVIDERS).length).toBeGreaterThan(0);
    }
  });

  it("pulls both libc variants for linux, which bun does not prune by libc", () => {
    expect(nativePackagesForTarget("bun-linux-arm64", PROVIDERS).sort()).toEqual([
      "@opentui/core-linux-arm64",
      "@opentui/core-linux-arm64-musl",
      "@resvg/resvg-js-linux-arm64-gnu",
      "@resvg/resvg-js-linux-arm64-musl",
    ]);
    expect(nativePackagesForTarget("bun-linux-arm64-musl", PROVIDERS).sort()).toEqual([
      "@opentui/core-linux-arm64",
      "@opentui/core-linux-arm64-musl",
      "@resvg/resvg-js-linux-arm64-gnu",
      "@resvg/resvg-js-linux-arm64-musl",
    ]);
  });

  it("takes only the matching platform and architecture, never a sibling", () => {
    expect(nativePackagesForTarget("bun-darwin-x64", PROVIDERS).sort()).toEqual([
      "@opentui/core-darwin-x64",
      "@resvg/resvg-js-darwin-x64",
    ]);
    expect(nativePackagesForTarget("bun-linux-x64", PROVIDERS)).not.toContain(
      "@opentui/core-linux-arm64",
    );
    expect(nativePackagesForTarget("bun-linux-x64", PROVIDERS)).not.toContain(
      "@resvg/resvg-js-linux-arm64-gnu",
    );
  });

  it("never matches a platform that only appears later in the name", () => {
    // resvg also ships @resvg/resvg-js-android-arm64 for a different platform
    // that shares arm64; the platform must sit directly after the provider name.
    const withAndroid = {
      "@resvg/resvg-js": { ...RESVG, "@resvg/resvg-js-android-arm64": "2.6.2" },
    };
    expect(nativePackagesForTarget("bun-darwin-arm64", withAndroid)).not.toContain(
      "@resvg/resvg-js-android-arm64",
    );
  });

  it("returns nothing for a triple it cannot read, rather than guessing", () => {
    expect(nativePackagesForTarget("bun", PROVIDERS)).toEqual([]);
    expect(nativePackagesForTarget("bun-freebsd-riscv64", PROVIDERS)).toEqual([]);
  });

  it("defaults to what the installed native shim packages declare", () => {
    const providers = readNativeVersions();
    expect(Object.keys(providers)).toContain("@opentui/core");
    expect(Object.keys(providers)).toContain("@resvg/resvg-js");
    const declared = Object.keys(flattenProviders(providers));
    expect(declared).toContain(`@opentui/core-${process.platform}-${process.arch}`);
    expect(declared).toContain(`@resvg/resvg-js-${process.platform}-${process.arch}`);
    expect(nativePackagesForTarget(`bun-${process.platform}-${process.arch}`, providers)).toContain(
      `@opentui/core-${process.platform}-${process.arch}`,
    );
  });
});

describe("flattenProviders", () => {
  it("merges every provider's declarations by package name", () => {
    const merged = flattenProviders({
      "@opentui/core": { "@opentui/core-darwin-x64": "1.0.0" },
      "@resvg/resvg-js": { "@resvg/resvg-js-darwin-x64": "2.6.2" },
    });
    expect(merged).toEqual({
      "@opentui/core-darwin-x64": "1.0.0",
      "@resvg/resvg-js-darwin-x64": "2.6.2",
    });
  });
});

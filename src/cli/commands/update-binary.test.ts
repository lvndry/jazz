import { afterEach, describe, expect, it } from "bun:test";
import { findExpectedChecksum, resolveReleaseAssetName } from "./update-binary";

describe("binary update", () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  function pretendPlatform(platform: string, arch: string): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
  });

  describe("resolveReleaseAssetName", () => {
    it("names the macOS assets", () => {
      pretendPlatform("darwin", "arm64");
      expect(resolveReleaseAssetName()).toBe("jazz-darwin-arm64");

      pretendPlatform("darwin", "x64");
      expect(resolveReleaseAssetName()).toBe("jazz-darwin-x64");
    });

    it("names the Linux assets", () => {
      pretendPlatform("linux", "x64");
      expect(resolveReleaseAssetName()).toMatch(/^jazz-linux-x64(-musl)?$/);

      pretendPlatform("linux", "arm64");
      expect(resolveReleaseAssetName()).toMatch(/^jazz-linux-arm64(-musl)?$/);
    });

    it("returns null on platforms Jazz publishes no binary for", () => {
      pretendPlatform("win32", "x64");
      expect(resolveReleaseAssetName()).toBeNull();

      pretendPlatform("linux", "ppc64");
      expect(resolveReleaseAssetName()).toBeNull();
    });
  });

  describe("findExpectedChecksum", () => {
    const checksums = [
      "aaa1111111111111111111111111111111111111111111111111111111111111  jazz-darwin-arm64.gz",
      "bbb2222222222222222222222222222222222222222222222222222222222222 *jazz-linux-x64.gz",
      "",
    ].join("\n");

    it("finds a digest by asset name", () => {
      expect(findExpectedChecksum(checksums, "jazz-darwin-arm64.gz")).toBe(
        "aaa1111111111111111111111111111111111111111111111111111111111111",
      );
    });

    it("matches names written in sha256sum's binary-mode form", () => {
      expect(findExpectedChecksum(checksums, "jazz-linux-x64.gz")).toBe(
        "bbb2222222222222222222222222222222222222222222222222222222222222",
      );
    });

    it("returns null for an asset the release does not list", () => {
      expect(findExpectedChecksum(checksums, "jazz-linux-arm64-musl.gz")).toBeNull();
    });
  });
});

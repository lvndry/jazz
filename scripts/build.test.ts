import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import rootPackageJson from "../package.json";

interface NpmPackageJson {
  readonly bin?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
}

function readPackageJson(relativeDir: string): NpmPackageJson {
  const packageJsonPath = path.join(import.meta.dir, "..", relativeDir, "package.json");
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as NpmPackageJson;
}

const mainPackageJson = readPackageJson("npm/jazz-ai");
const darwinArm64PackageJson = readPackageJson("npm/jazz-ai-darwin-arm64");

describe("root package.json", () => {
  it("is private, so it can never be published by accident", () => {
    expect(rootPackageJson.private).toBe(true);
  });
});

describe("npm/jazz-ai package shape", () => {
  it("resolves the platform binary through optionalDependencies, not a bundled dist/", () => {
    expect(mainPackageJson.bin?.["jazz"]).toBe("./bin/jazz");
    expect(mainPackageJson.scripts?.["postinstall"]).toBe("node ./postinstall.mjs");
    expect(Object.keys(mainPackageJson.optionalDependencies ?? {}).length).toBeGreaterThan(0);
  });

  it("declares an optionalDependency for every platform package in npm/", () => {
    const platformPackages = Object.keys(mainPackageJson.optionalDependencies ?? {});
    expect(platformPackages).toContain("jazz-ai-darwin-arm64");
    expect(platformPackages).toContain("jazz-ai-linux-x64");
    expect(platformPackages).toContain("jazz-ai-linux-x64-musl");
  });
});

describe("npm/jazz-ai-<platform> package shape", () => {
  it("restricts install to its one platform/arch pair", () => {
    expect(darwinArm64PackageJson.os).toEqual(["darwin"]);
    expect(darwinArm64PackageJson.cpu).toEqual(["arm64"]);
  });

  it("ships the binary at bin/jazz", () => {
    expect(darwinArm64PackageJson.bin?.["jazz"]).toBe("./bin/jazz");
  });
});

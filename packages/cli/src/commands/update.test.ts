import { describe, expect, it } from "bun:test";
import { buildInstallArgs } from "./update";

describe("buildInstallArgs", () => {
  it("passes --trust on bun so the postinstall script can fetch the binary", () => {
    expect(buildInstallArgs("bun", "jazz-ai")).toEqual(["add", "-g", "--trust", "jazz-ai@latest"]);
  });

  it("installs globally with every other package manager", () => {
    expect(buildInstallArgs("pnpm", "jazz-ai")).toEqual(["add", "-g", "jazz-ai@latest"]);
    expect(buildInstallArgs("yarn", "jazz-ai")).toEqual(["global", "add", "jazz-ai@latest"]);
    expect(buildInstallArgs("npm", "jazz-ai")).toEqual(["install", "-g", "jazz-ai@latest"]);
  });

  it("falls back to the npm form for an unrecognised package manager", () => {
    expect(buildInstallArgs("corepack", "jazz-ai")).toEqual(["install", "-g", "jazz-ai@latest"]);
  });

  it("pins the requested package to @latest", () => {
    expect(buildInstallArgs("bun", "@scope/pkg")).toContain("@scope/pkg@latest");
  });
});

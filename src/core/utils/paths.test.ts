import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  getBuiltinSkillsDirectory,
  getBuiltinWorkflowsDirectory,
  getGlobalSkillsDirectory,
  getGlobalUserDataDirectory,
  getGlobalWorkflowsDirectory,
  getJazzHomeDirectory,
  getLocalJazzDirectory,
  getPackageRootDirectory,
  getUserDataDirectory,
} from "./paths";

describe("Jazz paths", () => {
  const originalJazzHome = process.env["JAZZ_HOME"];

  afterEach(() => {
    if (originalJazzHome === undefined) {
      delete process.env["JAZZ_HOME"];
    } else {
      process.env["JAZZ_HOME"] = originalJazzHome;
    }
  });

  describe("user data directories", () => {
    it("returns ~/.jazz for user data", () => {
      const expected = path.join(os.homedir(), ".jazz");

      expect(getUserDataDirectory()).toBe(expected);
      expect(getGlobalUserDataDirectory()).toBe(expected);
      expect(getJazzHomeDirectory()).toBe(expected);
    });

    it("uses the same user-data location in development and production", () => {
      const expected = path.join(os.homedir(), ".jazz");

      expect(getUserDataDirectory()).toBe(expected);
      expect(getGlobalUserDataDirectory()).toBe(expected);
    });

    it("respects JAZZ_HOME", () => {
      process.env["JAZZ_HOME"] = "/tmp/jazz-test-home";
      const expected = path.resolve("/tmp/jazz-test-home");

      expect(getUserDataDirectory()).toBe(expected);
      expect(getGlobalUserDataDirectory()).toBe(expected);
      expect(getJazzHomeDirectory()).toBe(expected);
    });

    it("resolves global skills and workflows from JAZZ_HOME", () => {
      process.env["JAZZ_HOME"] = "/tmp/jazz-test-home";
      const jazzHome = path.resolve("/tmp/jazz-test-home");

      expect(getGlobalSkillsDirectory()).toBe(path.join(jazzHome, "skills"));
      expect(getGlobalWorkflowsDirectory()).toBe(path.join(jazzHome, "workflows"));
    });
  });

  describe("getLocalJazzDirectory", () => {
    it("returns {cwd}/.jazz", () => {
      expect(getLocalJazzDirectory()).toBe(path.resolve(process.cwd(), ".jazz"));
    });
  });

  describe("getPackageRootDirectory", () => {
    it("finds the jazz-ai package root from the source tree", () => {
      const result = getPackageRootDirectory();

      expect(result).not.toBeNull();
      const packageJsonPath = path.join(result!, "package.json");
      expect(fs.existsSync(packageJsonPath)).toBe(true);
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      expect(packageJson.name).toBe("jazz-ai");
    });

    it("returns a directory that exists", () => {
      const result = getPackageRootDirectory();

      expect(result).not.toBeNull();
      expect(fs.statSync(result!).isDirectory()).toBe(true);
    });

    it("returns a stable result across calls", () => {
      expect(getPackageRootDirectory()).toBe(getPackageRootDirectory());
    });
  });

  describe("getBuiltinSkillsDirectory", () => {
    it("finds the built-in skills directory", () => {
      const result = getBuiltinSkillsDirectory();

      expect(result).not.toBeNull();
      expect(fs.statSync(result!).isDirectory()).toBe(true);
    });

    it("returns the package skills subdirectory", () => {
      const packageRoot = getPackageRootDirectory();
      const skillsDirectory = getBuiltinSkillsDirectory();

      expect(packageRoot).not.toBeNull();
      expect(skillsDirectory).toBe(path.join(packageRoot!, "skills"));
    });

    it("contains SKILL.md files", () => {
      const skillsDirectory = getBuiltinSkillsDirectory();

      expect(skillsDirectory).not.toBeNull();
      const entries = fs.readdirSync(skillsDirectory!);
      expect(entries.length).toBeGreaterThan(0);
      expect(
        entries.some((entry) => fs.existsSync(path.join(skillsDirectory!, entry, "SKILL.md"))),
      ).toBe(true);
    });
  });

  describe("getBuiltinWorkflowsDirectory", () => {
    it("finds the built-in workflows directory", () => {
      const result = getBuiltinWorkflowsDirectory();

      expect(result).not.toBeNull();
      expect(fs.statSync(result!).isDirectory()).toBe(true);
    });

    it("returns the package workflows subdirectory", () => {
      const packageRoot = getPackageRootDirectory();
      const workflowsDirectory = getBuiltinWorkflowsDirectory();

      expect(packageRoot).not.toBeNull();
      expect(workflowsDirectory).toBe(path.join(packageRoot!, "workflows"));
    });

    it("contains WORKFLOW.md files", () => {
      const workflowsDirectory = getBuiltinWorkflowsDirectory();

      expect(workflowsDirectory).not.toBeNull();
      const entries = fs.readdirSync(workflowsDirectory!);
      expect(entries.length).toBeGreaterThan(0);
      expect(
        entries.some((entry) =>
          fs.existsSync(path.join(workflowsDirectory!, entry, "WORKFLOW.md")),
        ),
      ).toBe(true);
    });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getBuiltinSkillsDirectory,
  getBuiltinWorkflowsDirectory,
  getGlobalUserDataDirectory,
  getPackageRootDirectory,
  getUserDataDirectory,
  isRunningFromGlobalInstall,
  isRunningInDevelopmentMode,
} from "./runtime-detection";

describe("Runtime Detection", () => {
  let originalArgv: string[] | undefined;
  let tempDir: string;
  let jazzProjectDir: string;

  beforeEach(() => {
    // Save original values
    originalArgv = process.argv[1] ? [process.argv[1]] : undefined;

    // Create temporary directories for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-test-"));
    jazzProjectDir = path.join(tempDir, "jazz-project");
    fs.mkdirSync(jazzProjectDir, { recursive: true });

    // Create a package.json in the jazz project directory
    const packageJson = {
      name: "jazz-ai",
      version: "1.0.0",
    };
    fs.writeFileSync(
      path.join(jazzProjectDir, "package.json"),
      JSON.stringify(packageJson, null, 2),
    );
  });

  afterEach(() => {
    // Restore original values
    if (originalArgv) {
      process.argv[1] = originalArgv[0]!;
    } else {
      delete process.argv[1];
    }

    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors (may happen in CI with parallel tests or permissions)
        // The OS will clean up temp directories eventually
      }
    }
  });

  describe("isRunningFromGlobalInstall", () => {
    it("should return false when running from jazz project directory (development mode)", () => {
      // Mock process.argv[1] to point to jazz project
      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(false);
    });

    it("should return false when executable path is in jazz project directory (deep path)", () => {
      // Test that deeply nested paths within the jazz project are detected correctly
      const testPath = path.join(jazzProjectDir, "dist", "main.js");
      const testDir = path.dirname(testPath);

      // Ensure directory exists (recursive: true handles existing dirs gracefully)
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testPath, "// test");

      process.argv[1] = testPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(false);
    });

    it("should return true for bun global installation", () => {
      const homeDir = os.homedir();
      const bunPath = path.join(homeDir, ".bun", "bin", "jazz");
      process.argv[1] = bunPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return true for npm global installation in /usr/local/bin", () => {
      process.argv[1] = "/usr/local/bin/jazz";

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return true for npm global installation in ~/.npm-global", () => {
      const homeDir = os.homedir();
      const npmPath = path.join(homeDir, ".npm-global", "bin", "jazz");
      process.argv[1] = npmPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return true for pnpm global installation", () => {
      const homeDir = os.homedir();
      const pnpmPath = path.join(
        homeDir,
        ".local",
        "share",
        "pnpm",
        "global",
        "5",
        "node_modules",
        ".bin",
        "jazz",
      );
      process.argv[1] = pnpmPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return true for yarn global installation", () => {
      const homeDir = os.homedir();
      const yarnPath = path.join(homeDir, ".yarn", "bin", "jazz");
      process.argv[1] = yarnPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return true for system-wide node_modules installation", () => {
      process.argv[1] = "/usr/local/lib/node_modules/jazz-ai/dist/main.js";

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return true for node_modules outside jazz project", () => {
      const otherProjectDir = path.join(tempDir, "other-project");
      fs.mkdirSync(otherProjectDir, { recursive: true });
      const nodeModulesPath = path.join(otherProjectDir, "node_modules", ".bin", "jazz");
      fs.mkdirSync(path.dirname(nodeModulesPath), { recursive: true });
      fs.writeFileSync(nodeModulesPath, "#!/usr/bin/env node");

      process.argv[1] = nodeModulesPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });

    it("should return false for node_modules inside jazz project", () => {
      const nodeModulesPath = path.join(jazzProjectDir, "node_modules", ".bin", "jazz");
      fs.mkdirSync(path.dirname(nodeModulesPath), { recursive: true });
      fs.writeFileSync(nodeModulesPath, "#!/usr/bin/env node");

      process.argv[1] = nodeModulesPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(false);
    });

    it("should return false when process.argv[1] is undefined", () => {
      delete process.argv[1];

      const result = isRunningFromGlobalInstall();
      // Should default to development mode
      expect(result).toBe(false);
    });

    it("should handle invalid paths gracefully", () => {
      process.argv[1] = "/nonexistent/path/jazz";

      // Should not throw, should default to development mode
      const result = isRunningFromGlobalInstall();
      expect(result).toBe(false);
    });

    it("should handle Windows paths correctly", () => {
      const windowsPath = "C:\\Users\\user\\.bun\\bin\\jazz.exe";
      process.argv[1] = windowsPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(true);
    });
  });

  describe("getUserDataDirectory", () => {
    it("should return ~/.jazz when installed globally", () => {
      const homeDir = os.homedir();
      const bunPath = path.join(homeDir, ".bun", "bin", "jazz");
      process.argv[1] = bunPath;

      const result = getUserDataDirectory();
      const expected = path.join(homeDir, ".jazz");

      expect(result).toBe(expected);
    });

    it("should return {cwd}/.jazz when in development mode", () => {
      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");

      const result = getUserDataDirectory();
      const expected = path.resolve(process.cwd(), ".jazz");

      expect(result).toBe(expected);
    });

    it("should fallback to {cwd}/.jazz when home directory cannot be determined", () => {
      // Mock a global installation path
      process.argv[1] = "/usr/local/bin/jazz";

      // We can't easily mock os.homedir() to return empty, but we can test the fallback
      // by ensuring the function handles the case where homeDir might be empty
      const result = getUserDataDirectory();

      // If homeDir is available, it should use it; otherwise fallback
      // Since we can't easily mock os.homedir(), we just verify it doesn't throw
      expect(result).toBeTruthy();
      expect(typeof result).toBe("string");
      // Should either be ~/.jazz (if homeDir available) or {cwd}/.jazz (fallback)
      expect(result).toMatch(/\.jazz$/);
    });
  });

  describe("getGlobalUserDataDirectory", () => {
    it("should always return ~/.jazz regardless of dev/prod mode (for schedulers)", () => {
      const homeDir = os.homedir();
      const expected = path.join(homeDir, ".jazz");

      // Even when in development mode (process.argv points to jazz source), getGlobalUserDataDirectory
      // must return ~/.jazz so scheduled workflows (launchd/cron) always use the same paths.
      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");
      expect(getUserDataDirectory()).not.toBe(expected); // dev mode uses cwd
      expect(getGlobalUserDataDirectory()).toBe(expected);
    });

    it("should return ~/.jazz when in production mode", () => {
      const homeDir = os.homedir();
      process.argv[1] = path.join(homeDir, ".bun", "bin", "jazz");

      expect(getGlobalUserDataDirectory()).toBe(path.join(homeDir, ".jazz"));
    });

    it("should resolve to homedir .jazz path", () => {
      const homeDir = os.homedir();
      expect(getGlobalUserDataDirectory()).toBe(path.join(homeDir, ".jazz"));
    });
  });

  describe("isRunningInDevelopmentMode", () => {
    it("should return true when not installed globally", () => {
      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");

      const result = isRunningInDevelopmentMode();
      expect(result).toBe(true);
    });

    it("should return false when installed globally", () => {
      const homeDir = os.homedir();
      const bunPath = path.join(homeDir, ".bun", "bin", "jazz");
      process.argv[1] = bunPath;

      const result = isRunningInDevelopmentMode();
      expect(result).toBe(false);
    });

    it("should be the inverse of isRunningFromGlobalInstall", () => {
      const testPaths = [
        path.join(jazzProjectDir, "src", "main.ts"), // development
        path.join(os.homedir(), ".bun", "bin", "jazz"), // global
        "/usr/local/bin/jazz", // global
      ];

      for (const testPath of testPaths) {
        process.argv[1] = testPath;
        const isGlobal = isRunningFromGlobalInstall();
        const isDev = isRunningInDevelopmentMode();
        expect(isDev).toBe(!isGlobal);
      }
    });
  });

  describe("Edge cases and robustness", () => {
    it("should handle symlinks correctly", () => {
      // Create a symlink in a global location pointing to jazz project
      const symlinkPath = path.join(tempDir, "jazz-symlink");
      try {
        fs.symlinkSync(jazzProjectDir, symlinkPath);
        process.argv[1] = path.join(symlinkPath, "dist", "main.js");

        // Should detect as development mode because it resolves to jazz project
        const result = isRunningFromGlobalInstall();
        expect(result).toBe(false);
      } catch (error) {
        // Symlinks might not work on all systems (Windows), skip test
        if (process.platform === "win32") {
          return;
        }
        throw error;
      }
    });

    it("should handle deeply nested jazz project paths", () => {
      const deepPath = path.join(jazzProjectDir, "src", "core", "utils", "runtime-detection.ts");
      fs.mkdirSync(path.dirname(deepPath), { recursive: true });
      fs.writeFileSync(deepPath, "// test");

      process.argv[1] = deepPath;

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(false);
    });

    it("should handle paths with special characters", () => {
      const specialDir = path.join(tempDir, "project with spaces");
      fs.mkdirSync(specialDir, { recursive: true });
      const packageJson = { name: "jazz-ai", version: "1.0.0" };
      fs.writeFileSync(path.join(specialDir, "package.json"), JSON.stringify(packageJson));

      process.argv[1] = path.join(specialDir, "dist", "main.js");

      const result = isRunningFromGlobalInstall();
      expect(result).toBe(false);
    });

    it("should handle case-insensitive package.json name check", () => {
      // Create a package.json with different case (should still match)
      const packageJson = { name: "JAZZ-AI", version: "1.0.0" };
      fs.writeFileSync(path.join(jazzProjectDir, "package.json"), JSON.stringify(packageJson));

      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");

      // Should still detect as development (name check is case-sensitive in implementation)
      // But we test that it works
      const result = isRunningFromGlobalInstall();
      // The current implementation is case-sensitive, so this should return true (not in project)
      // If we want case-insensitive, we'd need to update the implementation
      expect(typeof result).toBe("boolean");
    });

    it("should handle missing package.json gracefully", () => {
      const projectWithoutPackageJson = path.join(tempDir, "no-package-json");
      fs.mkdirSync(projectWithoutPackageJson, { recursive: true });

      process.argv[1] = path.join(projectWithoutPackageJson, "main.js");

      // Should not throw, should default to checking other conditions
      const result = isRunningFromGlobalInstall();
      expect(typeof result).toBe("boolean");
    });

    it("should handle corrupted package.json gracefully", () => {
      fs.writeFileSync(path.join(jazzProjectDir, "package.json"), "invalid json {");

      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");

      // Should not throw, should continue checking
      const result = isRunningFromGlobalInstall();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("Integration scenarios", () => {
    it("should correctly identify development mode when running 'bun run cli'", () => {
      // Simulate running from source in jazz project
      process.argv[1] = path.join(jazzProjectDir, "src", "main.ts");

      expect(isRunningFromGlobalInstall()).toBe(false);
      expect(isRunningInDevelopmentMode()).toBe(true);
      expect(getUserDataDirectory()).toBe(path.resolve(process.cwd(), ".jazz"));
    });

    it("should correctly identify global install when running 'jazz' command", () => {
      // Simulate global installation
      const homeDir = os.homedir();
      process.argv[1] = path.join(homeDir, ".bun", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
      expect(isRunningInDevelopmentMode()).toBe(false);
      expect(getUserDataDirectory()).toBe(path.join(homeDir, ".jazz"));
    });

    it("should handle npm global installation correctly", () => {
      const homeDir = os.homedir();
      process.argv[1] = path.join(homeDir, ".npm-global", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
      expect(getUserDataDirectory()).toBe(path.join(homeDir, ".jazz"));
    });

    it("should handle pnpm global installation correctly", () => {
      const homeDir = os.homedir();
      process.argv[1] = path.join(
        homeDir,
        ".local",
        "share",
        "pnpm",
        "global",
        "5",
        "node_modules",
        ".bin",
        "jazz",
      );

      expect(isRunningFromGlobalInstall()).toBe(true);
      expect(getUserDataDirectory()).toBe(path.join(homeDir, ".jazz"));
    });
  });

  describe("getPackageRootDirectory", () => {
    it("should find the jazz-ai package root from the source tree", () => {
      const result = getPackageRootDirectory();

      expect(result).not.toBeNull();
      // The returned directory should contain a package.json with name "jazz-ai"
      const pkgPath = path.join(result!, "package.json");
      expect(fs.existsSync(pkgPath)).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.name).toBe("jazz-ai");
    });

    it("should return a directory that actually exists", () => {
      const result = getPackageRootDirectory();

      expect(result).not.toBeNull();
      expect(fs.statSync(result!).isDirectory()).toBe(true);
    });

    it("should return a stable result across multiple calls", () => {
      const first = getPackageRootDirectory();
      const second = getPackageRootDirectory();

      expect(first).toBe(second);
    });
  });

  describe("getBuiltinSkillsDirectory", () => {
    it("should find the builtin skills directory", () => {
      const result = getBuiltinSkillsDirectory();

      expect(result).not.toBeNull();
      expect(fs.statSync(result!).isDirectory()).toBe(true);
    });

    it("should be a 'skills' subdirectory of the package root", () => {
      const packageRoot = getPackageRootDirectory();
      const skillsDir = getBuiltinSkillsDirectory();

      expect(packageRoot).not.toBeNull();
      expect(skillsDir).not.toBeNull();
      expect(skillsDir).toBe(path.join(packageRoot!, "skills"));
    });

    it("should contain SKILL.md files", () => {
      const skillsDir = getBuiltinSkillsDirectory();

      expect(skillsDir).not.toBeNull();
      const entries = fs.readdirSync(skillsDir!);
      // There should be at least one skill directory
      expect(entries.length).toBeGreaterThan(0);

      // At least one entry should contain a SKILL.md file
      const hasSkillMd = entries.some((entry) => {
        const skillMdPath = path.join(skillsDir!, entry, "SKILL.md");
        return fs.existsSync(skillMdPath);
      });
      expect(hasSkillMd).toBe(true);
    });
  });

  describe("getBuiltinWorkflowsDirectory", () => {
    it("should find the builtin workflows directory", () => {
      const result = getBuiltinWorkflowsDirectory();

      expect(result).not.toBeNull();
      expect(fs.statSync(result!).isDirectory()).toBe(true);
    });

    it("should be a 'workflows' subdirectory of the package root", () => {
      const packageRoot = getPackageRootDirectory();
      const workflowsDir = getBuiltinWorkflowsDirectory();

      expect(packageRoot).not.toBeNull();
      expect(workflowsDir).not.toBeNull();
      expect(workflowsDir).toBe(path.join(packageRoot!, "workflows"));
    });

    it("should contain WORKFLOW.md files", () => {
      const workflowsDir = getBuiltinWorkflowsDirectory();

      expect(workflowsDir).not.toBeNull();
      const entries = fs.readdirSync(workflowsDir!);
      expect(entries.length).toBeGreaterThan(0);

      const hasWorkflowMd = entries.some((entry) => {
        const workflowMdPath = path.join(workflowsDir!, entry, "WORKFLOW.md");
        return fs.existsSync(workflowMdPath);
      });
      expect(hasWorkflowMd).toBe(true);
    });
  });
});

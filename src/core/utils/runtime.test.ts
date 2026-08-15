import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isOfflineMode, isRunningFromGlobalInstall, isRunningInDevelopmentMode } from "./runtime";

describe("isOfflineMode", () => {
  it("accepts only the documented enabled values", () => {
    const originalValue = process.env["JAZZ_OFFLINE"];
    try {
      process.env["JAZZ_OFFLINE"] = "1";
      expect(isOfflineMode()).toBe(true);
      process.env["JAZZ_OFFLINE"] = "true";
      expect(isOfflineMode()).toBe(true);
      process.env["JAZZ_OFFLINE"] = "True";
      expect(isOfflineMode()).toBe(false);
    } finally {
      if (originalValue === undefined) delete process.env["JAZZ_OFFLINE"];
      else process.env["JAZZ_OFFLINE"] = originalValue;
    }
  });
});

describe("Runtime detection", () => {
  let originalArgv: string[] | undefined;
  let tempDirectory: string;
  let jazzProjectDirectory: string;

  beforeEach(() => {
    originalArgv = process.argv[1] ? [process.argv[1]] : undefined;
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-test-"));
    jazzProjectDirectory = path.join(tempDirectory, "jazz-project");
    fs.mkdirSync(jazzProjectDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(jazzProjectDirectory, "package.json"),
      JSON.stringify({ name: "jazz-ai", version: "1.0.0" }, null, 2),
    );
  });

  afterEach(() => {
    if (originalArgv) {
      process.argv[1] = originalArgv[0]!;
    } else {
      delete process.argv[1];
    }

    if (tempDirectory && fs.existsSync(tempDirectory)) {
      try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      } catch {
        // The operating system can clean up an inaccessible temporary directory.
      }
    }
  });

  describe("isRunningFromGlobalInstall", () => {
    it("returns false from a Jazz source directory", () => {
      process.argv[1] = path.join(jazzProjectDirectory, "src", "main.ts");

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("returns false from a deeply nested Jazz source path", () => {
      const testPath = path.join(jazzProjectDirectory, "dist", "main.js");
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, "// test");
      process.argv[1] = testPath;

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("returns true for a Bun global installation", () => {
      process.argv[1] = path.join(os.homedir(), ".bun", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("returns true for an npm global installation in /usr/local/bin", () => {
      process.argv[1] = "/usr/local/bin/jazz";

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("returns true for an npm global installation in ~/.npm-global", () => {
      process.argv[1] = path.join(os.homedir(), ".npm-global", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("returns true for a pnpm global installation", () => {
      process.argv[1] = path.join(
        os.homedir(),
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
    });

    it("returns true for a yarn global installation", () => {
      process.argv[1] = path.join(os.homedir(), ".yarn", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("returns true for a system-wide node_modules installation", () => {
      process.argv[1] = "/usr/local/lib/node_modules/jazz-ai/dist/main.js";

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("returns true for node_modules outside the Jazz project", () => {
      const executablePath = path.join(
        tempDirectory,
        "other-project",
        "node_modules",
        ".bin",
        "jazz",
      );
      fs.mkdirSync(path.dirname(executablePath), { recursive: true });
      fs.writeFileSync(executablePath, "#!/usr/bin/env node");
      process.argv[1] = executablePath;

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("returns false for node_modules inside the Jazz project", () => {
      const executablePath = path.join(jazzProjectDirectory, "node_modules", ".bin", "jazz");
      fs.mkdirSync(path.dirname(executablePath), { recursive: true });
      fs.writeFileSync(executablePath, "#!/usr/bin/env node");
      process.argv[1] = executablePath;

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("returns false when process.argv[1] is undefined", () => {
      delete process.argv[1];

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("handles invalid paths", () => {
      process.argv[1] = "/nonexistent/path/jazz";

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("handles Windows paths", () => {
      process.argv[1] = "C:\\Users\\user\\.bun\\bin\\jazz.exe";

      expect(isRunningFromGlobalInstall()).toBe(true);
    });
  });

  describe("isRunningInDevelopmentMode", () => {
    it("returns true when Jazz is not installed globally", () => {
      process.argv[1] = path.join(jazzProjectDirectory, "src", "main.ts");

      expect(isRunningInDevelopmentMode()).toBe(true);
    });

    it("returns false when Jazz is installed globally", () => {
      process.argv[1] = path.join(os.homedir(), ".bun", "bin", "jazz");

      expect(isRunningInDevelopmentMode()).toBe(false);
    });

    it("is the inverse of isRunningFromGlobalInstall", () => {
      const testPaths = [
        path.join(jazzProjectDirectory, "src", "main.ts"),
        path.join(os.homedir(), ".bun", "bin", "jazz"),
        "/usr/local/bin/jazz",
      ];

      for (const testPath of testPaths) {
        process.argv[1] = testPath;
        expect(isRunningInDevelopmentMode()).toBe(!isRunningFromGlobalInstall());
      }
    });
  });

  describe("edge cases", () => {
    it("handles symlinks into the Jazz project", () => {
      const symlinkPath = path.join(tempDirectory, "jazz-symlink");
      try {
        fs.symlinkSync(jazzProjectDirectory, symlinkPath);
        process.argv[1] = path.join(symlinkPath, "dist", "main.js");

        expect(isRunningFromGlobalInstall()).toBe(false);
      } catch (error) {
        if (process.platform === "win32") {
          return;
        }
        throw error;
      }
    });

    it("handles deeply nested Jazz project paths", () => {
      const deepPath = path.join(jazzProjectDirectory, "src", "core", "utils", "runtime.ts");
      fs.mkdirSync(path.dirname(deepPath), { recursive: true });
      fs.writeFileSync(deepPath, "// test");
      process.argv[1] = deepPath;

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("handles paths with special characters", () => {
      const specialDirectory = path.join(tempDirectory, "project with spaces");
      fs.mkdirSync(specialDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(specialDirectory, "package.json"),
        JSON.stringify({ name: "jazz-ai", version: "1.0.0" }),
      );
      process.argv[1] = path.join(specialDirectory, "dist", "main.js");

      expect(isRunningFromGlobalInstall()).toBe(false);
    });

    it("handles a differently cased package name", () => {
      fs.writeFileSync(
        path.join(jazzProjectDirectory, "package.json"),
        JSON.stringify({ name: "JAZZ-AI", version: "1.0.0" }),
      );
      process.argv[1] = path.join(jazzProjectDirectory, "src", "main.ts");

      expect(typeof isRunningFromGlobalInstall()).toBe("boolean");
    });

    it("handles a missing package.json", () => {
      const projectDirectory = path.join(tempDirectory, "no-package-json");
      fs.mkdirSync(projectDirectory, { recursive: true });
      process.argv[1] = path.join(projectDirectory, "main.js");

      expect(typeof isRunningFromGlobalInstall()).toBe("boolean");
    });

    it("handles a corrupted package.json", () => {
      fs.writeFileSync(path.join(jazzProjectDirectory, "package.json"), "invalid json {");
      process.argv[1] = path.join(jazzProjectDirectory, "src", "main.ts");

      expect(typeof isRunningFromGlobalInstall()).toBe("boolean");
    });
  });

  describe("installation scenarios", () => {
    it("identifies development mode for bun run cli", () => {
      process.argv[1] = path.join(jazzProjectDirectory, "src", "main.ts");

      expect(isRunningFromGlobalInstall()).toBe(false);
      expect(isRunningInDevelopmentMode()).toBe(true);
    });

    it("identifies a global Jazz command", () => {
      process.argv[1] = path.join(os.homedir(), ".bun", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
      expect(isRunningInDevelopmentMode()).toBe(false);
    });

    it("identifies an npm global installation", () => {
      process.argv[1] = path.join(os.homedir(), ".npm-global", "bin", "jazz");

      expect(isRunningFromGlobalInstall()).toBe(true);
    });

    it("identifies a pnpm global installation", () => {
      process.argv[1] = path.join(
        os.homedir(),
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
    });
  });
});

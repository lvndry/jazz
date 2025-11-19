import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createFileSystemContextServiceLayer, FileSystemContextServiceTag } from "./fs";

describe("FileSystemContextService", () => {
  const createTestLayer = () => {
    const shellLayer = createFileSystemContextServiceLayer();
    return Layer.provide(shellLayer, NodeFileSystem.layer);
  };

  describe("getCwd", () => {
    it("should default to current working directory when no working directory is set", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const cwd = yield* shell.getCwd({ agentId: "test-agent" });
        return cwd;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe(process.cwd());
    });

    it("should return set working directory for specific agent", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const testPath = "/tmp/test-dir";

        // Create the test directory first
        yield* Effect.promise(() =>
          import("fs/promises").then((fs) => fs.mkdir(testPath, { recursive: true })),
        );

        // First set a working directory
        yield* shell.setCwd({ agentId: "test-agent" }, testPath);

        // Then get it back
        const cwd = yield* shell.getCwd({ agentId: "test-agent" });
        return cwd;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/tmp/test-dir");
    });
  });

  describe("resolvePath", () => {
    it("should handle absolute paths correctly", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, "/usr/bin");
        return resolved;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/usr/bin");
    });

    it("should resolve relative paths from working directory", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, "Documents", {
          skipExistenceCheck: true,
        });
        return resolved;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe(`${process.cwd()}/Documents`);
    });
  });

  describe("path normalization", () => {
    it("should handle backslash-escaped spaces", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, "/tmp/Test\\ Directory/", {
          skipExistenceCheck: true,
        });
        return resolved;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/tmp/Test Directory/");
    });

    it("should handle double-quoted paths", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, '"/tmp/Test Directory/"', {
          skipExistenceCheck: true,
        });
        return resolved;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/tmp/Test Directory/");
    });

    it("should handle single-quoted paths", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, "'/tmp/Test Directory/'", {
          skipExistenceCheck: true,
        });
        return resolved;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/tmp/Test Directory/");
    });

    it("should handle mixed escaping", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, '"/tmp/Test\\ Directory/"', {
          skipExistenceCheck: true,
        });
        return resolved;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/tmp/Test Directory/");
    });

    it("should handle paths with multiple spaces", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const resolved = yield* shell.resolvePath({ agentId: "test" }, '"/My Folder With Spaces/"');
        return resolved;
      }).pipe(Effect.catchAll((error) => Effect.succeed(error.message)));

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      // The path doesn't exist, so we should get an error message
      expect(result).toContain("Path not found");
    });
  });

  describe("escapePath", () => {
    it("should escape paths with spaces", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const escaped = shell.escapePath("/tmp/Test Directory/");
        return escaped;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe('"/tmp/Test Directory/"');
    });

    it("should escape paths with special characters", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const escaped = shell.escapePath("/path/with(special)chars/");
        return escaped;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe('"/path/with(special)chars/"');
    });

    it("should not escape simple paths", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const escaped = shell.escapePath("/simple/path/");
        return escaped;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe("/simple/path/");
    });

    it("should handle already quoted paths", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const escaped = shell.escapePath('"/already/quoted/"');
        return escaped;
      });

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toBe('"/already/quoted/"');
    });
  });

  describe("findDirectory", () => {
    it("should find directories by name", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        // Create a controlled test environment
        const testDir = "/tmp/jazz-test-find-controlled";
        const fs = yield* Effect.promise(() => import("fs/promises"));

        // Create test directory structure
        yield* Effect.promise(() => fs.mkdir(`${testDir}/bin`, { recursive: true }));
        yield* Effect.promise(() => fs.mkdir(`${testDir}/sbin`, { recursive: true }));
        yield* Effect.promise(() => fs.mkdir(`${testDir}/other`, { recursive: true }));

        // Set working directory to our test directory
        yield* shell.setCwd({ agentId: "test" }, testDir);
        const found = yield* shell.findDirectory({ agentId: "test" }, "bin", 2);

        // Clean up
        yield* Effect.promise(() => fs.rm(testDir, { recursive: true, force: true }));

        return found;
      });

      const result = (await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      )) as {
        results: string[];
        warnings?: string[];
      };

      // Should find our test bin directory
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.some((path: string) => path.includes("bin"))).toBe(true);
    });

    it("should return empty array when no directories found", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const found = yield* shell.findDirectory(
          { agentId: "test" },
          "nonexistentdirectory12345",
          1,
        );
        return found;
      });

      const result = (await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      )) as {
        results: string[];
        warnings?: string[];
      };

      expect(result.results).toEqual([]);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain("No directories found matching");
    });

    it("should find directories in current working directory", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        // Create a test directory structure
        const testDir = "/tmp/jazz-test-find";
        yield* Effect.promise(() =>
          import("fs/promises").then((fs) => fs.mkdir(`${testDir}/subdir`, { recursive: true })),
        );

        // Set working directory to our test directory
        yield* shell.setCwd({ agentId: "test" }, testDir);
        const found = yield* shell.findDirectory({ agentId: "test" }, "subdir", 2);

        // Clean up
        yield* Effect.promise(() =>
          import("fs/promises").then((fs) => fs.rm(testDir, { recursive: true, force: true })),
        );

        return found;
      });

      const result = (await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      )) as {
        results: string[];
        warnings?: string[];
      };

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.some((path: string) => path.includes("subdir"))).toBe(true);
    });

    it("should handle permission errors gracefully", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        // Try to search from root, which may have permission issues in CI
        yield* shell.setCwd({ agentId: "test" }, "/");
        const found = yield* shell.findDirectory({ agentId: "test" }, "bin", 1);
        return found;
      });

      const result = (await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      )) as {
        results: string[];
        warnings?: string[];
      };

      // Should return an object with results and potentially warnings
      expect(result).toHaveProperty("results");
      expect(Array.isArray(result.results)).toBe(true);

      // If we get results, they should be valid paths
      if (result.results.length > 0) {
        expect(result.results.every((path: string) => typeof path === "string")).toBe(true);
      }

      // If there are permission issues, we should get warnings
      if (result.warnings) {
        expect(Array.isArray(result.warnings)).toBe(true);
        expect(result.warnings.every((warning: string) => typeof warning === "string")).toBe(true);
      }
    });
  });

  describe("error handling", () => {
    it("should provide helpful error messages for non-existent paths", async () => {
      const testEffect = Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        yield* shell.resolvePath({ agentId: "test" }, "/absolute/nonexistent/path");
        return "should not reach here";
      }).pipe(Effect.catchAll((error) => Effect.succeed(error.message)));

      const result = await Effect.runPromise(
        testEffect.pipe(Effect.provide(createTestLayer())) as any,
      );

      expect(result).toContain("Path not found");
    });
  });
});

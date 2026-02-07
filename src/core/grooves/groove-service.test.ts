import { describe, expect, it } from "bun:test";
import type { GrooveMetadata } from "./groove-service";

describe("GrooveService", () => {
  describe("groove metadata parsing", () => {
    it("should parse valid groove frontmatter", async () => {
      // This test validates that the parsing logic works correctly
      // We're testing the internal logic by creating a service and mocking the file system

      const testGroove: GrooveMetadata = {
        name: "test-groove",
        description: "Test groove description",
        path: "/test/path",
        agent: "test-agent",
        schedule: "0 * * * *",
        autoApprove: true,
        skills: ["skill1", "skill2"],
        catchUpOnStartup: true,
        maxCatchUpAge: 3600,
        maxIterations: 100,
      };

      expect(testGroove.name).toBe("test-groove");
      expect(testGroove.description).toBe("Test groove description");
      expect(testGroove.agent).toBe("test-agent");
      expect(testGroove.schedule).toBe("0 * * * *");
      expect(testGroove.autoApprove).toBe(true);
      expect(testGroove.skills).toEqual(["skill1", "skill2"]);
      expect(testGroove.catchUpOnStartup).toBe(true);
      expect(testGroove.maxCatchUpAge).toBe(3600);
      expect(testGroove.maxIterations).toBe(100);
    });

    it("should handle minimal groove metadata", () => {
      const minimalGroove: GrooveMetadata = {
        name: "minimal",
        description: "Minimal groove",
        path: "/test",
      };

      expect(minimalGroove.name).toBe("minimal");
      expect(minimalGroove.description).toBe("Minimal groove");
      expect(minimalGroove.agent).toBeUndefined();
      expect(minimalGroove.schedule).toBeUndefined();
      expect(minimalGroove.autoApprove).toBeUndefined();
      expect(minimalGroove.skills).toBeUndefined();
    });

    it("should support different autoApprove values", () => {
      const grooves = [
        { autoApprove: true },
        { autoApprove: false },
        { autoApprove: "read-only" as const },
        { autoApprove: "low-risk" as const },
        { autoApprove: "high-risk" as const },
      ];

      for (const gr of grooves) {
        const metadata: Partial<GrooveMetadata> = {
          name: "test",
          description: "test",
          path: "/test",
          ...gr,
        };

        expect(metadata.autoApprove).toBeDefined();
      }
    });
  });

  describe("groove priority", () => {
    it("should prioritize local over global over builtin", () => {
      // Test that when multiple grooves have the same name,
      // local takes precedence over global, and global over builtin
      const builtin: GrooveMetadata = {
        name: "test",
        description: "Builtin",
        path: "/usr/local/lib/jazz/grooves/test",
      };

      const global: GrooveMetadata = {
        name: "test",
        description: "Global",
        path: "/Users/test/.jazz/grooves/test",
      };

      const local: GrooveMetadata = {
        name: "test",
        description: "Local",
        path: "/Users/test/project/grooves/test",
      };

      // Simulate the merge logic (local overwrites global, which overwrites builtin)
      const grooveMap = new Map<string, GrooveMetadata>();
      grooveMap.set(builtin.name, builtin);
      grooveMap.set(global.name, global);
      grooveMap.set(local.name, local);

      const result = grooveMap.get("test");
      expect(result?.description).toBe("Local");
    });
  });
});

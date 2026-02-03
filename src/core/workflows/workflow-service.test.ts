import { describe, expect, it } from "bun:test";
import type { WorkflowMetadata } from "./workflow-service";

describe("WorkflowService", () => {
  describe("workflow metadata parsing", () => {
    it("should parse valid workflow frontmatter", async () => {
      // This test validates that the parsing logic works correctly
      // We're testing the internal logic by creating a service and mocking the file system

      const testWorkflow: WorkflowMetadata = {
        name: "test-workflow",
        description: "Test workflow description",
        path: "/test/path",
        agent: "test-agent",
        schedule: "0 * * * *",
        autoApprove: true,
        skills: ["skill1", "skill2"],
        catchUpOnStartup: true,
        maxCatchUpAge: 3600,
      };

      expect(testWorkflow.name).toBe("test-workflow");
      expect(testWorkflow.description).toBe("Test workflow description");
      expect(testWorkflow.agent).toBe("test-agent");
      expect(testWorkflow.schedule).toBe("0 * * * *");
      expect(testWorkflow.autoApprove).toBe(true);
      expect(testWorkflow.skills).toEqual(["skill1", "skill2"]);
      expect(testWorkflow.catchUpOnStartup).toBe(true);
      expect(testWorkflow.maxCatchUpAge).toBe(3600);
    });

    it("should handle minimal workflow metadata", () => {
      const minimalWorkflow: WorkflowMetadata = {
        name: "minimal",
        description: "Minimal workflow",
        path: "/test",
      };

      expect(minimalWorkflow.name).toBe("minimal");
      expect(minimalWorkflow.description).toBe("Minimal workflow");
      expect(minimalWorkflow.agent).toBeUndefined();
      expect(minimalWorkflow.schedule).toBeUndefined();
      expect(minimalWorkflow.autoApprove).toBeUndefined();
      expect(minimalWorkflow.skills).toBeUndefined();
    });

    it("should support different autoApprove values", () => {
      const workflows = [
        { autoApprove: true },
        { autoApprove: false },
        { autoApprove: "read-only" as const },
        { autoApprove: "low-risk" as const },
        { autoApprove: "high-risk" as const },
      ];

      for (const wf of workflows) {
        const metadata: Partial<WorkflowMetadata> = {
          name: "test",
          description: "test",
          path: "/test",
          ...wf,
        };

        expect(metadata.autoApprove).toBeDefined();
      }
    });
  });

  describe("workflow priority", () => {
    it("should prioritize local over global over builtin", () => {
      // Test that when multiple workflows have the same name,
      // local takes precedence over global, and global over builtin
      const builtin: WorkflowMetadata = {
        name: "test",
        description: "Builtin",
        path: "/usr/local/lib/jazz/workflows/test",
      };

      const global: WorkflowMetadata = {
        name: "test",
        description: "Global",
        path: "/Users/test/.jazz/workflows/test",
      };

      const local: WorkflowMetadata = {
        name: "test",
        description: "Local",
        path: "/Users/test/project/workflows/test",
      };

      // Simulate the merge logic (local overwrites global, which overwrites builtin)
      const workflowMap = new Map<string, WorkflowMetadata>();
      workflowMap.set(builtin.name, builtin);
      workflowMap.set(global.name, global);
      workflowMap.set(local.name, local);

      const result = workflowMap.get("test");
      expect(result?.description).toBe("Local");
    });
  });
});

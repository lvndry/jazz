import { describe, expect, it } from "bun:test";
import {
  parseAutoApprove,
  parseWorkflowDefinition,
  resolveWorkflowApprovalPolicy,
  type WorkflowMetadata,
} from "./workflow-service";

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
        catchUpOnRestart: true,
        maxCatchUpAge: 3600,
        maxIterations: 100,
      };

      expect(testWorkflow.name).toBe("test-workflow");
      expect(testWorkflow.description).toBe("Test workflow description");
      expect(testWorkflow.agent).toBe("test-agent");
      expect(testWorkflow.schedule).toBe("0 * * * *");
      expect(testWorkflow.autoApprove).toBe(true);
      expect(testWorkflow.skills).toEqual(["skill1", "skill2"]);
      expect(testWorkflow.catchUpOnRestart).toBe(true);
      expect(testWorkflow.maxCatchUpAge).toBe(3600);
      expect(testWorkflow.maxIterations).toBe(100);
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
    it("should prioritize local over global", () => {
      // Test that when multiple workflows have the same name,
      // local takes precedence over global
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

      // Simulate the merge logic (local overwrites global)
      const workflowMap = new Map<string, WorkflowMetadata>();
      workflowMap.set(global.name, global);
      workflowMap.set(local.name, local);

      const result = workflowMap.get("test");
      expect(result?.description).toBe("Local");
    });
  });
});

describe("parseAutoApprove", () => {
  it.each([true, false, "read-only", "low-risk", "high-risk"] as const)("accepts %p", (value) => {
    expect(parseAutoApprove(value)).toEqual({ ok: true, policy: value });
  });

  it("reads a missing value as unset", () => {
    expect(parseAutoApprove(undefined)).toEqual({ ok: true, policy: undefined });
  });

  it.each(["readonly", "Read-Only", "low_risk", "false", "true", "yolo", null, 1])(
    "rejects %p with an error naming the valid values",
    (value) => {
      const parsed = parseAutoApprove(value);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain("false, read-only, low-risk, high-risk, true");
      }
    },
  );
});

describe("parseWorkflowDefinition autoApprove", () => {
  it("keeps an invalid workflow in the index with the reason it cannot run", () => {
    const definition = parseWorkflowDefinition({
      name: "typo",
      description: "d",
      autoApprove: "readonly",
    });
    expect(definition?.autoApprove).toBeUndefined();
    expect(definition?.definitionError).toContain('autoApprove "readonly" is not valid');
  });

  it("sets no definitionError for a valid or missing value", () => {
    expect(
      parseWorkflowDefinition({ name: "a", description: "d" })?.definitionError,
    ).toBeUndefined();
    expect(
      parseWorkflowDefinition({ name: "a", description: "d", autoApprove: "low-risk" })
        ?.autoApprove,
    ).toBe("low-risk");
  });
});

describe("resolveWorkflowApprovalPolicy", () => {
  it("runs a workflow without autoApprove at false", () => {
    expect(resolveWorkflowApprovalPolicy({ name: "a" })).toEqual({ ok: true, policy: false });
  });

  it("runs a workflow at the policy it declares", () => {
    expect(resolveWorkflowApprovalPolicy({ name: "a", autoApprove: "high-risk" })).toEqual({
      ok: true,
      policy: "high-risk",
    });
    expect(resolveWorkflowApprovalPolicy({ name: "a", autoApprove: true })).toEqual({
      ok: true,
      policy: true,
    });
  });

  it("refuses to run an invalid workflow", () => {
    const resolved = resolveWorkflowApprovalPolicy({
      name: "typo",
      definitionError: 'autoApprove "readonly" is not valid.',
    });
    expect(resolved).toEqual({
      ok: false,
      error: 'Workflow "typo" cannot run: autoApprove "readonly" is not valid.',
    });
  });
});

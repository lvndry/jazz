import { describe, expect, it } from "bun:test";
import type { WorkflowMetadata } from "./workflow-service";
import { groupWorkflows, formatWorkflow } from "./workflow-utils";

describe("Workflow Utilities", () => {
  const cwd = process.cwd();
  const homeDir = process.env["HOME"] || "/tmp";

  const mockWorkflows: WorkflowMetadata[] = [
    {
      name: "local-wf",
      description: "Local description",
      path: `${cwd}/workflows/local/WORKFLOW.md`,
    },
    {
      name: "global-wf",
      description: "Global description",
      path: `${homeDir}/.jazz/workflows/global/WORKFLOW.md`,
    },
    {
      name: "builtin-wf",
      description: "Built-in description",
      path: "/usr/local/lib/jazz/workflows/builtin/WORKFLOW.md",
    },
  ];

  describe("groupWorkflows", () => {
    it("should correctly group workflows by location", () => {
      const { local, global, builtin } = groupWorkflows(mockWorkflows);
      expect(local.length).toBe(1);
      expect(local[0]?.name).toBe("local-wf");
      expect(global.length).toBe(1);
      expect(global[0]?.name).toBe("global-wf");
      expect(builtin.length).toBe(1);
      expect(builtin[0]?.name).toBe("builtin-wf");
    });
  });

  describe("formatWorkflow", () => {
    it("should format a workflow without status badge", () => {
      const wf = mockWorkflows[0]!;
      const result = formatWorkflow(wf);
      expect(result).toContain("local-wf");
      expect(result).toContain("Local description");
    });

    it("should format a workflow with status badge", () => {
      const wf = mockWorkflows[0]!;
      const result = formatWorkflow(wf, { statusBadge: " [ACTIVE]" });
      expect(result).toContain("local-wf [ACTIVE]");
      expect(result).toContain("Local description");
    });

    it("should include schedule and agent info if present", () => {
      const wf: WorkflowMetadata = {
        name: "scheduled-wf",
        description: "Scheduled description",
        path: "/path/to/wf",
        schedule: "0 9 * * *",
        agent: "test-agent",
      };
      const result = formatWorkflow(wf);
      expect(result).toContain("scheduled-wf");
      expect(result).toContain("At 09:00 AM");
      expect(result).toContain("agent: test-agent");
    });
  });
});

import { describe, expect, it } from "bun:test";
import type { WorkflowRunRecord } from "./run-history";

describe("WorkflowRunRecord", () => {
  describe("run record structure", () => {
    it("should store all required fields", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test-workflow",
        startedAt: "2026-02-03T08:00:00Z",
        completedAt: "2026-02-03T08:05:00Z",
        status: "completed",
        triggeredBy: "manual",
      };

      expect(record.workflowName).toBe("test-workflow");
      expect(record.startedAt).toBeDefined();
      expect(record.completedAt).toBeDefined();
      expect(record.status).toBe("completed");
      expect(record.triggeredBy).toBe("manual");
    });

    it("should support running status without completedAt", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "running",
        triggeredBy: "scheduled",
      };

      expect(record.status).toBe("running");
      expect(record.completedAt).toBeUndefined();
    });

    it("should support failed status with error", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        completedAt: "2026-02-03T08:01:00Z",
        status: "failed",
        error: "Agent not found",
        triggeredBy: "manual",
      };

      expect(record.status).toBe("failed");
      expect(record.error).toBe("Agent not found");
    });

    it("should support both manual and scheduled triggers", () => {
      const manual: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "completed",
        triggeredBy: "manual",
      };

      const scheduled: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T09:00:00Z",
        status: "completed",
        triggeredBy: "scheduled",
      };

      expect(manual.triggeredBy).toBe("manual");
      expect(scheduled.triggeredBy).toBe("scheduled");
    });
  });

  describe("status transitions", () => {
    it("should follow valid status lifecycle", () => {
      const validStatuses: WorkflowRunRecord["status"][] = ["running", "completed", "failed"];

      for (const status of validStatuses) {
        const record: WorkflowRunRecord = {
          workflowName: "test",
          startedAt: "2026-02-03T08:00:00Z",
          status,
          triggeredBy: "manual",
        };

        expect(record.status).toBe(status);
      }
    });
  });
});

import { describe, expect, it } from "bun:test";
import type { WorkflowRunRecord } from "./run-history";

describe("WorkflowRunRecord", () => {
  describe("record structure", () => {
    it("should store all required fields for a running workflow", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test-workflow",
        startedAt: "2026-02-03T08:00:00Z",
        status: "running",
        triggeredBy: "manual",
      };

      expect(record.workflowName).toBe("test-workflow");
      expect(record.startedAt).toBe("2026-02-03T08:00:00Z");
      expect(record.status).toBe("running");
      expect(record.triggeredBy).toBe("manual");
      expect(record.completedAt).toBeUndefined();
      expect(record.error).toBeUndefined();
    });

    it("should store all fields for a completed workflow", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test-workflow",
        startedAt: "2026-02-03T08:00:00Z",
        completedAt: "2026-02-03T08:05:00Z",
        status: "completed",
        triggeredBy: "scheduled",
      };

      expect(record.status).toBe("completed");
      expect(record.completedAt).toBe("2026-02-03T08:05:00Z");
      expect(record.triggeredBy).toBe("scheduled");
    });

    it("should store error information for failed workflows", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test-workflow",
        startedAt: "2026-02-03T08:00:00Z",
        completedAt: "2026-02-03T08:01:00Z",
        status: "failed",
        error: "Agent timeout",
        triggeredBy: "manual",
      };

      expect(record.status).toBe("failed");
      expect(record.error).toBe("Agent timeout");
    });
  });

  describe("status values", () => {
    it("should support running status", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "running",
        triggeredBy: "manual",
      };
      expect(record.status).toBe("running");
    });

    it("should support completed status", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "completed",
        triggeredBy: "manual",
      };
      expect(record.status).toBe("completed");
    });

    it("should support failed status", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "failed",
        triggeredBy: "manual",
      };
      expect(record.status).toBe("failed");
    });
  });

  describe("triggeredBy values", () => {
    it("should support manual trigger", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "running",
        triggeredBy: "manual",
      };
      expect(record.triggeredBy).toBe("manual");
    });

    it("should support scheduled trigger", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        status: "running",
        triggeredBy: "scheduled",
      };
      expect(record.triggeredBy).toBe("scheduled");
    });
  });

  describe("duration calculation", () => {
    it("should allow calculating duration from timestamps", () => {
      const record: WorkflowRunRecord = {
        workflowName: "test",
        startedAt: "2026-02-03T08:00:00Z",
        completedAt: "2026-02-03T08:05:30Z",
        status: "completed",
        triggeredBy: "manual",
      };

      const start = new Date(record.startedAt);
      const end = new Date(record.completedAt!);
      const durationMs = end.getTime() - start.getTime();
      const durationSeconds = durationMs / 1000;

      expect(durationSeconds).toBe(330); // 5 minutes 30 seconds
    });
  });
});

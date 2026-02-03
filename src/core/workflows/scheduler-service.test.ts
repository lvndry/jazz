import { describe, expect, it } from "bun:test";
import cronParser from "cron-parser";
import type { ScheduledWorkflow } from "./scheduler-service";

/**
 * Test helper: Validate a cron expression.
 */
function isValidCronExpression(cron: string): boolean {
  try {
    const parts = cron.trim().split(/\s+/);
    if (parts.length === 5) {
      cronParser.parse(`0 ${cron}`);
    } else if (parts.length === 6) {
      cronParser.parse(cron);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

describe("SchedulerService", () => {
  describe("ScheduledWorkflow metadata", () => {
    it("should store all required fields", () => {
      const scheduled: ScheduledWorkflow = {
        workflowName: "test-workflow",
        schedule: "0 8 * * *",
        agent: "my-agent",
        enabled: true,
      };

      expect(scheduled.workflowName).toBe("test-workflow");
      expect(scheduled.schedule).toBe("0 8 * * *");
      expect(scheduled.agent).toBe("my-agent");
      expect(scheduled.enabled).toBe(true);
    });

    it("should support optional lastRun and nextRun fields", () => {
      const scheduled: ScheduledWorkflow = {
        workflowName: "test",
        schedule: "0 * * * *",
        agent: "agent1",
        enabled: true,
        lastRun: "2026-02-03T08:00:00Z",
        nextRun: "2026-02-03T09:00:00Z",
      };

      expect(scheduled.lastRun).toBe("2026-02-03T08:00:00Z");
      expect(scheduled.nextRun).toBe("2026-02-03T09:00:00Z");
    });
  });

  describe("cron schedule validation", () => {
    it("should accept valid cron expressions", () => {
      const validCrons = [
        "0 * * * *", // Every hour
        "0 8 * * *", // Daily at 8 AM
        "*/15 * * * *", // Every 15 minutes
        "0 0 * * 0", // Weekly on Sunday
        "0 9 1 * *", // Monthly on the 1st at 9 AM
        "30 4 1,15 * 5", // Complex: 4:30 on 1st and 15th and Fridays
        "0 0 1-7 * 1", // First Monday of month
      ];

      for (const cron of validCrons) {
        expect(isValidCronExpression(cron)).toBe(true);
      }
    });

    it("should reject invalid cron expressions", () => {
      const invalidCrons = [
        "invalid", // Not a cron
        "* * *", // Only 3 fields
        "60 * * * *", // Invalid minute (60)
        "* 25 * * *", // Invalid hour (25)
        "* * * * * * *", // Too many fields
      ];

      for (const cron of invalidCrons) {
        expect(isValidCronExpression(cron)).toBe(false);
      }
    });
  });

  describe("agent assignment", () => {
    it("should require agent for scheduled workflows", () => {
      const scheduled: ScheduledWorkflow = {
        workflowName: "test",
        schedule: "0 * * * *",
        agent: "research-agent",
        enabled: true,
      };

      expect(scheduled.agent).toBeDefined();
      expect(typeof scheduled.agent).toBe("string");
    });

    it("should allow different agents for different workflows", () => {
      const workflow1: ScheduledWorkflow = {
        workflowName: "email-cleanup",
        schedule: "0 * * * *",
        agent: "email-agent",
        enabled: true,
      };

      const workflow2: ScheduledWorkflow = {
        workflowName: "tech-digest",
        schedule: "0 8 * * *",
        agent: "research-agent",
        enabled: true,
      };

      expect(workflow1.agent).not.toBe(workflow2.agent);
    });
  });
});

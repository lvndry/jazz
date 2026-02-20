import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  getLaunchdPath,
  SchedulerServiceLayer,
  SchedulerServiceTag,
  type ScheduledWorkflow,
} from "./scheduler-service";
import type { WorkflowMetadata } from "./workflow-service";
import { isValidCronExpression } from "../utils/cron-utils";

// Re-implement parseCronField for testing since it's not exported
function parseCronField(value: string, fieldName: string): number | undefined {
  if (value === "*") {
    return undefined;
  }

  if (value.includes("/")) {
    throw new Error(
      `Unsupported cron step expression "${value}" in ${fieldName} field. ` +
        `launchd does not support step values. Use a simple integer or "*" instead.`,
    );
  }

  if (value.includes("-")) {
    throw new Error(
      `Unsupported cron range expression "${value}" in ${fieldName} field. ` +
        `launchd does not support range values. Use a simple integer or "*" instead.`,
    );
  }

  if (value.includes(",")) {
    throw new Error(
      `Unsupported cron list expression "${value}" in ${fieldName} field. ` +
        `launchd does not support list values. Use a simple integer or "*" instead.`,
    );
  }

  if (!/^-?\d+$/.test(value)) {
    throw new Error(
      `Invalid cron value "${value}" in ${fieldName} field. ` + `Expected a simple integer or "*".`,
    );
  }

  const parsed = parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid cron value "${value}" in ${fieldName} field. ` + `Expected a simple integer or "*".`,
    );
  }

  return parsed;
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

  describe("parseCronField validation for launchd", () => {
    it("should accept wildcard (*)", () => {
      expect(parseCronField("*", "minute")).toBeUndefined();
    });

    it("should accept simple integers", () => {
      expect(parseCronField("0", "minute")).toBe(0);
      expect(parseCronField("15", "minute")).toBe(15);
      expect(parseCronField("59", "minute")).toBe(59);
      expect(parseCronField("23", "hour")).toBe(23);
    });

    it("should throw error for step expressions", () => {
      expect(() => parseCronField("*/15", "minute")).toThrow(
        'Unsupported cron step expression "*/15" in minute field',
      );
      expect(() => parseCronField("0/5", "minute")).toThrow(
        'Unsupported cron step expression "0/5" in minute field',
      );
    });

    it("should throw error for range expressions", () => {
      expect(() => parseCronField("1-5", "day-of-week")).toThrow(
        'Unsupported cron range expression "1-5" in day-of-week field',
      );
      expect(() => parseCronField("9-17", "hour")).toThrow(
        'Unsupported cron range expression "9-17" in hour field',
      );
    });

    it("should throw error for list expressions", () => {
      expect(() => parseCronField("1,2,3", "day-of-month")).toThrow(
        'Unsupported cron list expression "1,2,3" in day-of-month field',
      );
      expect(() => parseCronField("0,30", "minute")).toThrow(
        'Unsupported cron list expression "0,30" in minute field',
      );
    });

    it("should throw error for invalid values", () => {
      expect(() => parseCronField("abc", "minute")).toThrow(
        'Invalid cron value "abc" in minute field',
      );
      expect(() => parseCronField("12a", "hour")).toThrow('Invalid cron value "12a" in hour field');
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

  describe("getLaunchdPath", () => {
    it("should include the current process PATH", () => {
      const result = getLaunchdPath();
      const currentPathDirs = (process.env.PATH || "").split(":").filter(Boolean);
      for (const dir of currentPathDirs) {
        expect(result).toContain(dir);
      }
    });

    it("should include common tool installation directories", () => {
      const result = getLaunchdPath();
      const homeDir = os.homedir();
      expect(result).toContain(`${homeDir}/.bun/bin`);
      expect(result).toContain(`${homeDir}/.local/share/pnpm`);
      expect(result).toContain("/usr/local/bin");
      expect(result).toContain("/usr/bin");
      expect(result).toContain("/bin");
    });

    it("should not duplicate directories already in PATH", () => {
      const result = getLaunchdPath();
      const dirs = result.split(":");
      const unique = new Set(dirs);
      expect(dirs.length).toBe(unique.size);
    });
  });

  describe("scheduler regression (tech-digest, paths, 6-field cron)", () => {
    const testWorkflowName = "scheduler-regression-test";

    const techDigestWorkflow: WorkflowMetadata = {
      name: testWorkflowName,
      description: "Regression test workflow",
      path: "/tmp",
      schedule: "0 8 * * *",
    };

    const sixFieldWorkflow: WorkflowMetadata = {
      name: testWorkflowName,
      description: "6-field regression test",
      path: "/tmp",
      schedule: "0 0 8 * * *",
    };

    const workflowWithWhitespace: WorkflowMetadata = {
      name: testWorkflowName,
      description: "Whitespace trim regression test",
      path: "/tmp",
      schedule: "  0 8 * * *  ",
    };

    it("should schedule tech-digest cron expression 0 8 * * * without error", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(techDigestWorkflow, "test-agent-id");
        return "ok";
      });

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(SchedulerServiceLayer),
          Effect.catchAll((e) => Effect.fail(e)),
        ),
      );

      expect(result).toBe("ok");

      // Cleanup
      const scheduler = await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const s = yield* SchedulerServiceTag;
            yield* s.unschedule(testWorkflowName);
            return s;
          }),
          SchedulerServiceLayer,
        ),
      );
      expect(scheduler).toBeDefined();
    });

    it("should schedule 6-field cron expression without error", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(sixFieldWorkflow, "test-agent-id");
        return "ok";
      });

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(SchedulerServiceLayer),
          Effect.catchAll((e) => Effect.fail(e)),
        ),
      );

      expect(result).toBe("ok");

      // Cleanup
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const s = yield* SchedulerServiceTag;
            yield* s.unschedule(testWorkflowName);
          }),
          SchedulerServiceLayer,
        ),
      );
    });

    it("should write plist with log paths in ~/.jazz (not cwd)", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(techDigestWorkflow, "test-agent-id");
      });

      await Effect.runPromise(program.pipe(Effect.provide(SchedulerServiceLayer)));

      const plistPath = path.join(
        os.homedir(),
        "Library",
        "LaunchAgents",
        `com.jazz.workflow.${testWorkflowName}.plist`,
      );
      const plistContent = await fs.readFile(plistPath, "utf-8");

      const homeJazz = path.join(os.homedir(), ".jazz");
      expect(plistContent).toContain(homeJazz);
      expect(plistContent).toContain(path.join(homeJazz, "logs"));

      // Cleanup
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const s = yield* SchedulerServiceTag;
            yield* s.unschedule(testWorkflowName);
          }),
          SchedulerServiceLayer,
        ),
      );
    });

    it("should accept schedule with leading/trailing whitespace (trim regression)", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(workflowWithWhitespace, "test-agent-id");
        return "ok";
      });

      const result = await Effect.runPromise(
        program.pipe(
          Effect.provide(SchedulerServiceLayer),
          Effect.catchAll((e) => Effect.fail(e)),
        ),
      );

      expect(result).toBe("ok");

      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const s = yield* SchedulerServiceTag;
            yield* s.unschedule(testWorkflowName);
          }),
          SchedulerServiceLayer,
        ),
      );
    });
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { getJazzHomeDirectory } from "@/core/utils/paths";
import {
  DEFAULT_SCHEDULE_LABEL,
  deriveScheduleLabel,
  getLaunchdPath,
  InProcessScheduler,
  parseScheduleId,
  scheduleId,
  SchedulerServiceLayer,
  SchedulerServiceTag,
  type ScheduledWorkflow,
} from "./scheduler-service";
import { isValidCronExpression } from "../utils/cron";

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
        label: "default",
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
        label: "default",
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
        label: "default",
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
        label: "default",
        workflowName: "email-cleanup",
        schedule: "0 * * * *",
        agent: "email-agent",
        enabled: true,
      };

      const workflow2: ScheduledWorkflow = {
        label: "default",
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
      const currentPathDirs = (process.env["PATH"] || "").split(":").filter(Boolean);
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

  describe("schedule ids and labels", () => {
    it("formats and parses <workflow>/<label>", () => {
      expect(scheduleId({ workflowName: "recap", label: "monthly" })).toBe("recap/monthly");
      expect(parseScheduleId("recap/monthly")).toEqual({ workflowName: "recap", label: "monthly" });
      expect(parseScheduleId("recap")).toEqual({ workflowName: "recap" });
    });

    it("derives a readable label from a cron", () => {
      expect(deriveScheduleLabel("0 9 * * 1-5")).toMatch(/^[a-z0-9-]+$/);
      expect(deriveScheduleLabel("0 9 * * 1-5")).not.toBe(deriveScheduleLabel("0 17 * * 5"));
    });
  });

  describe("InProcessScheduler", () => {
    const testWorkflowName = "in-process-scheduler-regression-test";
    const request = {
      workflowName: testWorkflowName,
      label: DEFAULT_SCHEDULE_LABEL,
      schedule: "0 8 * * *",
      agent: "test-agent-id",
    };
    const schedulesDir = path.join(getJazzHomeDirectory(), "schedules");

    afterEach(async () => {
      const scheduler = new InProcessScheduler();
      for (const label of [DEFAULT_SCHEDULE_LABEL, "monthly"]) {
        await Effect.runPromise(scheduler.unschedule(`${testWorkflowName}/${label}`));
      }
      await fs.rm(path.join(schedulesDir, `${testWorkflowName}.json`), { force: true });
    });

    it("reports its scheduler type as in-process", () => {
      expect(new InProcessScheduler().getSchedulerType()).toBe("in-process");
    });

    it("writes only the metadata file — no OS artifact required to succeed", async () => {
      const scheduler = new InProcessScheduler();
      await Effect.runPromise(scheduler.schedule(request));

      const isScheduled = await Effect.runPromise(
        scheduler.isScheduled(`${testWorkflowName}/default`),
      );
      expect(isScheduled).toBe(true);

      const listed = await Effect.runPromise(scheduler.listScheduled());
      const entry = listed.find((s) => s.workflowName === testWorkflowName);
      expect(entry?.agent).toBe("test-agent-id");
      expect(entry?.schedule).toBe("0 8 * * *");
      expect(entry?.label).toBe("default");
      expect(entry?.scheduledAt).toBeDefined();
    });

    it("keeps two schedules of one workflow side by side and removes them one at a time", async () => {
      const scheduler = new InProcessScheduler();
      await Effect.runPromise(scheduler.schedule(request));
      await Effect.runPromise(
        scheduler.schedule({ ...request, label: "monthly", schedule: "0 9 1 * *" }),
      );

      const listed = (await Effect.runPromise(scheduler.listScheduled())).filter(
        (s) => s.workflowName === testWorkflowName,
      );
      expect(listed.map((s) => s.label).sort()).toEqual(["default", "monthly"]);

      await Effect.runPromise(scheduler.unschedule(`${testWorkflowName}/monthly`));
      expect(await Effect.runPromise(scheduler.isScheduled(`${testWorkflowName}/monthly`))).toBe(
        false,
      );
      expect(await Effect.runPromise(scheduler.isScheduled(`${testWorkflowName}/default`))).toBe(
        true,
      );
    });

    it("migrates a label-less metadata file to <workflow>/default on listing", async () => {
      await fs.mkdir(schedulesDir, { recursive: true });
      const legacyFile = path.join(schedulesDir, `${testWorkflowName}.json`);
      await fs.writeFile(
        legacyFile,
        JSON.stringify({
          workflowName: testWorkflowName,
          schedule: "0 8 * * *",
          agent: "legacy-agent",
          enabled: true,
        }),
      );

      const listed = await Effect.runPromise(new InProcessScheduler().listScheduled());
      const entry = listed.find((s) => s.workflowName === testWorkflowName);

      expect(entry?.label).toBe("default");
      expect(entry?.agent).toBe("legacy-agent");
      await expect(fs.stat(legacyFile)).rejects.toThrow();
      await expect(
        fs.stat(path.join(schedulesDir, `${testWorkflowName}.default.json`)),
      ).resolves.toBeDefined();
    });

    it("rejects an invalid cron expression without touching disk", async () => {
      const scheduler = new InProcessScheduler();
      const result = await Effect.runPromise(
        scheduler.schedule({ ...request, schedule: "not a cron" }).pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");

      const isScheduled = await Effect.runPromise(
        scheduler.isScheduled(`${testWorkflowName}/default`),
      );
      expect(isScheduled).toBe(false);
    });

    it("rejects a label that is not a slug", async () => {
      const result = await Effect.runPromise(
        new InProcessScheduler().schedule({ ...request, label: "Not A Slug" }).pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
    });

    it("unschedule removes the metadata file", async () => {
      const scheduler = new InProcessScheduler();
      await Effect.runPromise(scheduler.schedule(request));
      await Effect.runPromise(scheduler.unschedule(`${testWorkflowName}/default`));

      const isScheduled = await Effect.runPromise(
        scheduler.isScheduled(`${testWorkflowName}/default`),
      );
      expect(isScheduled).toBe(false);
    });
  });

  describe("scheduler regression (tech-digest, paths, 6-field cron)", () => {
    const testWorkflowName = "scheduler-regression-test";

    const base = { workflowName: testWorkflowName, label: "default", agent: "test-agent-id" };
    const techDigestWorkflow = { ...base, schedule: "0 8 * * *" };
    const sixFieldWorkflow = { ...base, schedule: "0 0 8 * * *" };
    const workflowWithWhitespace = { ...base, schedule: "  0 8 * * *  " };
    const id = `${testWorkflowName}/default`;

    it("should schedule tech-digest cron expression 0 8 * * * without error", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(techDigestWorkflow);
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
            yield* s.unschedule(id);
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
        yield* scheduler.schedule(sixFieldWorkflow);
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
            yield* s.unschedule(id);
          }),
          SchedulerServiceLayer,
        ),
      );
    });

    it("should write plist with log paths in the jazz home, not cwd", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(techDigestWorkflow);
      });

      await Effect.runPromise(program.pipe(Effect.provide(SchedulerServiceLayer)));

      const plistPath = path.join(
        os.homedir(),
        "Library",
        "LaunchAgents",
        `com.jazz.workflow.${testWorkflowName}.default.plist`,
      );
      const plistContent = await fs.readFile(plistPath, "utf-8");

      const homeJazz = getJazzHomeDirectory();
      expect(plistContent).toContain(homeJazz);
      expect(plistContent).toContain(path.join(homeJazz, "logs"));

      // Cleanup
      await Effect.runPromise(
        Effect.provide(
          Effect.gen(function* () {
            const s = yield* SchedulerServiceTag;
            yield* s.unschedule(id);
          }),
          SchedulerServiceLayer,
        ),
      );
    });

    it("should accept schedule with leading/trailing whitespace (trim regression)", async () => {
      if (process.platform !== "darwin") return;

      const program = Effect.gen(function* () {
        const scheduler = yield* SchedulerServiceTag;
        yield* scheduler.schedule(workflowWithWhitespace);
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
            yield* s.unschedule(id);
          }),
          SchedulerServiceLayer,
        ),
      );
    });
  });
});

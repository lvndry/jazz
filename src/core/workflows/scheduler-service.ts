import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import plist from "plist";
import type { WorkflowMetadata } from "./workflow-service";
import { isValidCronExpression } from "../utils/cron-utils";
import { getJazzSchedulerInvocation, getUserDataDirectory } from "../utils/runtime-detection";
import { execCommand, execCommandWithStdin } from "../utils/shell-utils";

/**
 * Information about a scheduled workflow.
 */
export interface ScheduledWorkflow {
  readonly workflowName: string;
  readonly schedule: string;
  readonly agent: string; // Agent ID to use for this scheduled workflow
  readonly enabled: boolean;
  readonly lastRun?: string;
  readonly nextRun?: string;
}

/**
 * Service for managing workflow schedules using system schedulers.
 */
export interface SchedulerService {
  /**
   * Schedule a workflow for periodic execution.
   * @param workflow - The workflow metadata
   * @param agentId - The agent ID to use for scheduled runs (required)
   */
  readonly schedule: (workflow: WorkflowMetadata, agentId: string) => Effect.Effect<void, Error>;

  /**
   * Remove a workflow from the schedule.
   */
  readonly unschedule: (workflowName: string) => Effect.Effect<void, Error>;

  /**
   * List all scheduled workflows.
   */
  readonly listScheduled: () => Effect.Effect<readonly ScheduledWorkflow[], Error>;

  /**
   * Check if a workflow is currently scheduled.
   */
  readonly isScheduled: (workflowName: string) => Effect.Effect<boolean, Error>;

  /**
   * Get the scheduler type being used (launchd, cron, etc.)
   */
  readonly getSchedulerType: () => "launchd" | "cron" | "unsupported";
}

export const SchedulerServiceTag = Context.GenericTag<SchedulerService>("SchedulerService");

/**
 * Get the directory for storing schedule metadata.
 * Uses getUserDataDirectory() to respect development/production separation.
 */
function getSchedulesDirectory(): string {
  return path.join(getUserDataDirectory(), "schedules");
}

/**
 * Escape a string for safe use in shell commands.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
function escapeShellArg(arg: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Convert a cron expression to a launchd schedule dictionary.
 * Supports standard cron format: minute hour day-of-month month day-of-week
 */
function cronToLaunchdSchedule(
  cron: string,
): { Minute?: number; Hour?: number; Day?: number; Month?: number; Weekday?: number }[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron}. Expected 5 fields.`);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Build the schedule dictionary
  // launchd uses arrays of dictionaries for complex schedules
  const schedule: {
    Minute?: number;
    Hour?: number;
    Day?: number;
    Month?: number;
    Weekday?: number;
  } = {};

  if (minute !== "*") {
    schedule.Minute = parseInt(minute!, 10);
  }
  if (hour !== "*") {
    schedule.Hour = parseInt(hour!, 10);
  }
  if (dayOfMonth !== "*") {
    schedule.Day = parseInt(dayOfMonth!, 10);
  }
  if (month !== "*") {
    schedule.Month = parseInt(month!, 10);
  }
  if (dayOfWeek !== "*") {
    // Cron: 0=Sunday, launchd: 0=Sunday (same)
    schedule.Weekday = parseInt(dayOfWeek!, 10);
  }

  return [schedule];
}

/**
 * Generate a launchd plist file content.
 */
function generateLaunchdPlist(
  workflow: WorkflowMetadata,
  jazzInvocation: readonly string[],
  agentId: string,
): string {
  const schedule = cronToLaunchdSchedule(workflow.schedule!);
  const logDir = path.join(getUserDataDirectory(), "logs");

  const programArgs = [...jazzInvocation, "workflow", "run", workflow.name, "--agent", agentId, "--auto-approve"];

  const plistObject = {
    Label: `com.jazz.workflow.${workflow.name}`,
    ProgramArguments: programArgs,
    StartCalendarInterval: schedule,
    StandardOutPath: `${logDir}/${workflow.name}.log`,
    StandardErrorPath: `${logDir}/${workflow.name}.error.log`,
    RunAtLoad: false,
  };

  return plist.build(plistObject);
}

/**
 * Generate a crontab entry for a workflow.
 * Uses shell escaping to prevent command injection.
 */
function generateCrontabEntry(
  workflow: WorkflowMetadata,
  jazzInvocation: readonly string[],
  agentId: string,
): string {
  const logDir = path.join(getUserDataDirectory(), "logs");

  const escapedLogPath = escapeShellArg(`${logDir}/${workflow.name}.log`);

  const commandTokens = jazzInvocation.concat([
    "workflow",
    "run",
    workflow.name,
    "--agent",
    agentId,
    "--auto-approve",
  ]);

  // Build the command with proper escaping
  const command = commandTokens.map((token) => escapeShellArg(token)).join(" ");

  return `# Jazz workflow: ${workflow.name.replace(/\n/g, " ")}
${workflow.schedule} ${command} >> ${escapedLogPath} 2>&1`;
}

/**
 * Parse and validate a ScheduledWorkflow from JSON content.
 * Returns null if the content is invalid or missing required fields.
 */
function parseScheduledWorkflow(content: string): ScheduledWorkflow | null {
  try {
    const parsed = JSON.parse(content) as Partial<ScheduledWorkflow>;

    // Validate required fields
    if (typeof parsed.workflowName !== "string" || typeof parsed.schedule !== "string") {
      return null;
    }

    return {
      workflowName: parsed.workflowName,
      schedule: parsed.schedule,
      agent: typeof parsed.agent === "string" ? parsed.agent : "default",
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      ...(typeof parsed.lastRun === "string" && { lastRun: parsed.lastRun }),
      ...(typeof parsed.nextRun === "string" && { nextRun: parsed.nextRun }),
    };
  } catch {
    return null;
  }
}

/**
 * List all scheduled workflows from the schedules directory.
 * Shared implementation for both LaunchdScheduler and CronScheduler.
 */
function listScheduledFromMetadataFiles(): Effect.Effect<readonly ScheduledWorkflow[], Error> {
  return Effect.gen(function* () {
    const schedulesDir = getSchedulesDirectory();

    // Ensure directory exists
    yield* Effect.tryPromise(() => fs.mkdir(schedulesDir, { recursive: true }));

    // List metadata files
    const files = yield* Effect.tryPromise(() => fs.readdir(schedulesDir));
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const scheduled: ScheduledWorkflow[] = [];
    for (const file of jsonFiles) {
      const content = yield* Effect.tryPromise(() =>
        fs.readFile(path.join(schedulesDir, file), "utf-8"),
      ).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (content) {
        const metadata = parseScheduledWorkflow(content);
        if (metadata) {
          scheduled.push(metadata);
        }
      }
    }

    return scheduled;
  });
}

/**
 * Check if a workflow is scheduled by checking metadata file existence.
 */
function isScheduledByMetadata(workflowName: string): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    const metadataPath = path.join(getSchedulesDirectory(), `${workflowName}.json`);
    const stat = yield* Effect.tryPromise(() => fs.stat(metadataPath)).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    return stat !== null;
  });
}

/**
 * macOS launchd implementation of SchedulerService.
 */
class LaunchdScheduler implements SchedulerService {
  private readonly launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");

  getSchedulerType(): "launchd" | "cron" | "unsupported" {
    return "launchd";
  }

  private getPlistPath(workflowName: string): string {
    return path.join(this.launchAgentsDir, `com.jazz.workflow.${workflowName}.plist`);
  }

  private getMetadataPath(workflowName: string): string {
    return path.join(getSchedulesDirectory(), `${workflowName}.json`);
  }

  schedule(workflow: WorkflowMetadata, agentId: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: LaunchdScheduler) {
      if (!workflow.schedule) {
        return yield* Effect.fail(new Error(`Workflow ${workflow.name} has no schedule defined`));
      }

      if (!isValidCronExpression(workflow.schedule)) {
        return yield* Effect.fail(
          new Error(`Workflow ${workflow.name} has invalid cron expression: ${workflow.schedule}`),
        );
      }

      const jazzInvocation = yield* getJazzSchedulerInvocation();
      const plistContent = generateLaunchdPlist(workflow, jazzInvocation, agentId);
      const plistPath = this.getPlistPath(workflow.name);
      const metadataPath = this.getMetadataPath(workflow.name);

      // Ensure directories exist
      yield* Effect.tryPromise(() => fs.mkdir(this.launchAgentsDir, { recursive: true }));
      yield* Effect.tryPromise(() => fs.mkdir(getSchedulesDirectory(), { recursive: true }));
      yield* Effect.tryPromise(() =>
        fs.mkdir(path.join(getUserDataDirectory(), "logs"), { recursive: true }),
      );

      // Unload existing job if present (ignore errors)
      yield* execCommand("launchctl", ["unload", plistPath]).pipe(Effect.catchAll(() => Effect.void));

      // Write the plist file
      yield* Effect.tryPromise(() => fs.writeFile(plistPath, plistContent, "utf-8"));

      // Save metadata
      const metadata: ScheduledWorkflow = {
        workflowName: workflow.name,
        schedule: workflow.schedule,
        agent: agentId,
        enabled: true,
      };
      yield* Effect.tryPromise(() => fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2)));

      // Load the job
      yield* execCommand("launchctl", ["load", plistPath]);
    }.bind(this));
  }

  unschedule(workflowName: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: LaunchdScheduler) {
      const plistPath = this.getPlistPath(workflowName);
      const metadataPath = this.getMetadataPath(workflowName);

      // Unload the job (ignore errors if not loaded)
      yield* execCommand("launchctl", ["unload", plistPath]).pipe(
        Effect.catchAll(() => Effect.void),
      );

      // Remove the plist file
      yield* Effect.tryPromise(() => fs.unlink(plistPath)).pipe(Effect.catchAll(() => Effect.void));

      // Remove metadata
      yield* Effect.tryPromise(() => fs.unlink(metadataPath)).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }.bind(this));
  }

  listScheduled(): Effect.Effect<readonly ScheduledWorkflow[], Error> {
    return listScheduledFromMetadataFiles();
  }

  isScheduled(workflowName: string): Effect.Effect<boolean, Error> {
    return isScheduledByMetadata(workflowName);
  }
}

/**
 * Linux cron implementation of SchedulerService.
 */
class CronScheduler implements SchedulerService {
  private readonly cronMarker = "# Jazz workflow:";

  getSchedulerType(): "launchd" | "cron" | "unsupported" {
    return "cron";
  }

  private getMetadataPath(workflowName: string): string {
    return path.join(getSchedulesDirectory(), `${workflowName}.json`);
  }

  private getCurrentCrontab(): Effect.Effect<string, Error> {
    return execCommand("crontab", ["-l"]).pipe(
      Effect.catchAll(() => Effect.succeed("")), // No crontab returns error
    );
  }

  private setCrontab(content: string): Effect.Effect<void, Error> {
    return execCommandWithStdin("crontab", ["-"], content);
  }

  schedule(workflow: WorkflowMetadata, agentId: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: CronScheduler) {
      if (!workflow.schedule) {
        return yield* Effect.fail(new Error(`Workflow ${workflow.name} has no schedule defined`));
      }

      if (!isValidCronExpression(workflow.schedule)) {
        return yield* Effect.fail(
          new Error(`Workflow ${workflow.name} has invalid cron expression: ${workflow.schedule}`),
        );
      }

      const jazzInvocation = yield* getJazzSchedulerInvocation();
      const entry = generateCrontabEntry(workflow, jazzInvocation, agentId);
      const metadataPath = this.getMetadataPath(workflow.name);

      // Ensure directories exist
      yield* Effect.tryPromise(() => fs.mkdir(getSchedulesDirectory(), { recursive: true }));
      yield* Effect.tryPromise(() =>
        fs.mkdir(path.join(getUserDataDirectory(), "logs"), { recursive: true }),
      );

      // Get current crontab
      const crontab = yield* this.getCurrentCrontab();

      // Remove existing entry for this workflow
      const lines = crontab.split("\n");
      const filtered: string[] = [];
      let skipNext = false;
      for (const line of lines) {
        if (line.includes(`${this.cronMarker} ${workflow.name}`)) {
          skipNext = true;
          continue;
        }
        if (skipNext) {
          skipNext = false;
          continue;
        }
        filtered.push(line);
      }

      // Add new entry
      filtered.push(entry);

      // Set the new crontab
      yield* this.setCrontab(filtered.join("\n"));

      // Save metadata
      const metadata: ScheduledWorkflow = {
        workflowName: workflow.name,
        schedule: workflow.schedule,
        agent: agentId,
        enabled: true,
      };
      yield* Effect.tryPromise(() => fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2)));
    }.bind(this));
  }

  unschedule(workflowName: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: CronScheduler) {
      const metadataPath = this.getMetadataPath(workflowName);

      // Get current crontab
      const crontab = yield* this.getCurrentCrontab();

      // Remove entry for this workflow
      const lines = crontab.split("\n");
      const filtered: string[] = [];
      let skipNext = false;
      for (const line of lines) {
        if (line.includes(`${this.cronMarker} ${workflowName}`)) {
          skipNext = true;
          continue;
        }
        if (skipNext) {
          skipNext = false;
          continue;
        }
        filtered.push(line);
      }

      // Set the new crontab
      yield* this.setCrontab(filtered.join("\n"));

      // Remove metadata
      yield* Effect.tryPromise(() => fs.unlink(metadataPath)).pipe(
        Effect.catchAll(() => Effect.void),
      );
    }.bind(this));
  }

  listScheduled(): Effect.Effect<readonly ScheduledWorkflow[], Error> {
    return listScheduledFromMetadataFiles();
  }

  isScheduled(workflowName: string): Effect.Effect<boolean, Error> {
    return isScheduledByMetadata(workflowName);
  }
}

/**
 * Unsupported platform scheduler (no-op).
 */
class UnsupportedScheduler implements SchedulerService {
  getSchedulerType(): "launchd" | "cron" | "unsupported" {
    return "unsupported";
  }

  schedule(_workflow: WorkflowMetadata, _agentId: string): Effect.Effect<void, Error> {
    return Effect.fail(
      new Error("Scheduling is not supported on this platform. Supported: macOS, Linux."),
    );
  }

  unschedule(_workflowName: string): Effect.Effect<void, Error> {
    return Effect.fail(
      new Error("Scheduling is not supported on this platform. Supported: macOS, Linux."),
    );
  }

  listScheduled(): Effect.Effect<readonly ScheduledWorkflow[], Error> {
    return Effect.succeed([]);
  }

  isScheduled(_workflowName: string): Effect.Effect<boolean, Error> {
    return Effect.succeed(false);
  }
}

/**
 * Create the appropriate scheduler implementation for the current platform.
 */
function createScheduler(): SchedulerService {
  const platform = process.platform;

  if (platform === "darwin") {
    return new LaunchdScheduler();
  } else if (platform === "linux") {
    return new CronScheduler();
  } else {
    return new UnsupportedScheduler();
  }
}

/**
 * Layer providing the SchedulerService.
 */
export const SchedulerServiceLayer = Layer.succeed(SchedulerServiceTag, createScheduler());

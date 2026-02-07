import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import plist from "plist";
import type { GrooveMetadata } from "./groove-service";
import { isValidCronExpression } from "../utils/cron-utils";
import { getJazzSchedulerInvocation, getUserDataDirectory } from "../utils/runtime-detection";
import { execCommand, execCommandWithStdin } from "../utils/shell-utils";

/**
 * Information about a scheduled groove.
 */
export interface ScheduledGroove {
  readonly grooveName: string;
  readonly schedule: string;
  readonly agent: string; // Agent ID to use for this scheduled groove
  readonly enabled: boolean;
  readonly lastRun?: string;
  readonly nextRun?: string;
}

/**
 * Service for managing groove schedules using system schedulers.
 */
export interface SchedulerService {
  /**
   * Schedule a groove for periodic execution.
   * @param groove - The groove metadata
   * @param agentId - The agent ID to use for scheduled runs (required)
   */
  readonly schedule: (groove: GrooveMetadata, agentId: string) => Effect.Effect<void, Error>;

  /**
   * Remove a groove from the schedule.
   */
  readonly unschedule: (grooveName: string) => Effect.Effect<void, Error>;

  /**
   * List all scheduled grooves.
   */
  readonly listScheduled: () => Effect.Effect<readonly ScheduledGroove[], Error>;

  /**
   * Check if a groove is currently scheduled.
   */
  readonly isScheduled: (grooveName: string) => Effect.Effect<boolean, Error>;

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
 * Parse a single cron field, validating it is either "*" or a simple integer.
 * Throws an error for unsupported cron features like steps, ranges, or lists.
 *
 * @param value - The cron field value to parse
 * @param fieldName - Human-readable name of the field for error messages
 * @returns The parsed integer value, or undefined if the field is "*"
 */
function parseCronField(value: string, fieldName: string): number | undefined {
  // Wildcard is always valid
  if (value === "*") {
    return undefined;
  }

  // Check for unsupported step syntax (e.g., */15, 0/5)
  if (value.includes("/")) {
    throw new Error(
      `Unsupported cron step expression "${value}" in ${fieldName} field. ` +
        `launchd does not support step values. Use a simple integer or "*" instead.`,
    );
  }

  // Check for unsupported range syntax (e.g., 1-5, 9-17)
  if (value.includes("-")) {
    throw new Error(
      `Unsupported cron range expression "${value}" in ${fieldName} field. ` +
        `launchd does not support range values. Use a simple integer or "*" instead.`,
    );
  }

  // Check for unsupported list syntax (e.g., 1,2,3)
  if (value.includes(",")) {
    throw new Error(
      `Unsupported cron list expression "${value}" in ${fieldName} field. ` +
        `launchd does not support list values. Use a simple integer or "*" instead.`,
    );
  }

  // Validate it's a valid integer (only digits, optionally with leading sign)
  if (!/^-?\d+$/.test(value)) {
    throw new Error(
      `Invalid cron value "${value}" in ${fieldName} field. ` +
        `Expected a simple integer or "*".`,
    );
  }

  const parsed = parseInt(value, 10);

  // parseInt should not return NaN at this point given our regex check,
  // but we validate anyway for safety
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid cron value "${value}" in ${fieldName} field. ` +
        `Expected a simple integer or "*".`,
    );
  }

  return parsed;
}

/**
 * Convert a cron expression to a launchd schedule dictionary.
 * Supports standard cron format: minute hour day-of-month month day-of-week
 *
 * NOTE: launchd only supports simple integer values or wildcards for schedule fields.
 * Complex cron features like steps, ranges, and lists are NOT supported
 * and will throw an error.
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

  const parsedMinute = parseCronField(minute!, "minute");
  if (parsedMinute !== undefined) {
    schedule.Minute = parsedMinute;
  }

  const parsedHour = parseCronField(hour!, "hour");
  if (parsedHour !== undefined) {
    schedule.Hour = parsedHour;
  }

  const parsedDay = parseCronField(dayOfMonth!, "day-of-month");
  if (parsedDay !== undefined) {
    schedule.Day = parsedDay;
  }

  const parsedMonth = parseCronField(month!, "month");
  if (parsedMonth !== undefined) {
    schedule.Month = parsedMonth;
  }

  const parsedWeekday = parseCronField(dayOfWeek!, "day-of-week");
  if (parsedWeekday !== undefined) {
    // Cron: 0=Sunday, launchd: 0=Sunday (same)
    schedule.Weekday = parsedWeekday;
  }

  return [schedule];
}

/**
 * Generate a launchd plist file content.
 */
function generateLaunchdPlist(
  workflow: GrooveMetadata,
  jazzInvocation: readonly string[],
  agentId: string,
): string {
  const schedule = cronToLaunchdSchedule(workflow.schedule!);
  const logDir = path.join(getUserDataDirectory(), "logs");

  const programArgs = [...jazzInvocation, "groove", "run", workflow.name, "--agent", agentId, "--auto-approve"];

  const plistObject = {
    Label: `com.jazz.groove.${workflow.name}`,
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
  workflow: GrooveMetadata,
  jazzInvocation: readonly string[],
  agentId: string,
): string {
  const logDir = path.join(getUserDataDirectory(), "logs");

  const escapedLogPath = escapeShellArg(`${logDir}/${workflow.name}.log`);

  const commandTokens = jazzInvocation.concat([
    "groove",
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
 * Parse and validate a ScheduledGroove from JSON content.
 * Returns null if the content is invalid or missing required fields.
 */
function parseScheduledGroove(content: string): ScheduledGroove | null {
  try {
    const parsed = JSON.parse(content) as Partial<ScheduledGroove>;

    // Validate required fields
    if (typeof parsed.grooveName !== "string" || typeof parsed.schedule !== "string") {
      return null;
    }

    return {
      grooveName: parsed.grooveName,
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
function listScheduledFromMetadataFiles(): Effect.Effect<readonly ScheduledGroove[], Error> {
  return Effect.gen(function* () {
    const schedulesDir = getSchedulesDirectory();

    // Ensure directory exists
    yield* Effect.tryPromise(() => fs.mkdir(schedulesDir, { recursive: true }));

    // List metadata files
    const files = yield* Effect.tryPromise(() => fs.readdir(schedulesDir));
    const jsonFiles = files.filter((f) => f.endsWith(".json"));

    const scheduled: ScheduledGroove[] = [];
    for (const file of jsonFiles) {
      const content = yield* Effect.tryPromise(() =>
        fs.readFile(path.join(schedulesDir, file), "utf-8"),
      ).pipe(Effect.catchAll(() => Effect.succeed(null)));

      if (content) {
        const metadata = parseScheduledGroove(content);
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
function isScheduledByMetadata(grooveName: string): Effect.Effect<boolean, Error> {
  return Effect.gen(function* () {
    const metadataPath = path.join(getSchedulesDirectory(), `${grooveName}.json`);
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

  private getPlistPath(grooveName: string): string {
    return path.join(this.launchAgentsDir, `com.jazz.groove.${grooveName}.plist`);
  }

  private getMetadataPath(grooveName: string): string {
    return path.join(getSchedulesDirectory(), `${grooveName}.json`);
  }

  schedule(groove: GrooveMetadata, agentId: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: LaunchdScheduler) {
      if (!groove.schedule) {
        return yield* Effect.fail(new Error(`Groove ${groove.name} has no schedule defined`));
      }

      if (!isValidCronExpression(groove.schedule)) {
        return yield* Effect.fail(
          new Error(`Groove ${groove.name} has invalid cron expression: ${groove.schedule}`),
        );
      }

      const jazzInvocation = yield* getJazzSchedulerInvocation();
      const plistContent = generateLaunchdPlist(groove, jazzInvocation, agentId);
      const plistPath = this.getPlistPath(groove.name);
      const metadataPath = this.getMetadataPath(groove.name);

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
      const metadata: ScheduledGroove = {
        grooveName: groove.name,
        schedule: groove.schedule,
        agent: agentId,
        enabled: true,
      };
      yield* Effect.tryPromise(() => fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2)));

      // Load the job
      yield* execCommand("launchctl", ["load", plistPath]);
    }.bind(this));
  }

  unschedule(grooveName: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: LaunchdScheduler) {
      const plistPath = this.getPlistPath(grooveName);
      const metadataPath = this.getMetadataPath(grooveName);

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

  listScheduled(): Effect.Effect<readonly ScheduledGroove[], Error> {
    return listScheduledFromMetadataFiles();
  }

  isScheduled(grooveName: string): Effect.Effect<boolean, Error> {
    return isScheduledByMetadata(grooveName);
  }
}

/**
 * Linux cron implementation of SchedulerService.
 */
class CronScheduler implements SchedulerService {
  private readonly cronMarker = "# Jazz groove:";

  getSchedulerType(): "launchd" | "cron" | "unsupported" {
    return "cron";
  }

  private getMetadataPath(grooveName: string): string {
    return path.join(getSchedulesDirectory(), `${grooveName}.json`);
  }

  private getCurrentCrontab(): Effect.Effect<string, Error> {
    return execCommand("crontab", ["-l"]).pipe(
      Effect.catchAll(() => Effect.succeed("")), // No crontab returns error
    );
  }

  private setCrontab(content: string): Effect.Effect<void, Error> {
    return execCommandWithStdin("crontab", ["-"], content);
  }

  schedule(groove: GrooveMetadata, agentId: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: CronScheduler) {
      if (!groove.schedule) {
        return yield* Effect.fail(new Error(`Groove ${groove.name} has no schedule defined`));
      }

      if (!isValidCronExpression(groove.schedule)) {
        return yield* Effect.fail(
          new Error(`Groove ${groove.name} has invalid cron expression: ${groove.schedule}`),
        );
      }

      const jazzInvocation = yield* getJazzSchedulerInvocation();
      const entry = generateCrontabEntry(groove, jazzInvocation, agentId);
      const metadataPath = this.getMetadataPath(groove.name);

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
        if (line.includes(`${this.cronMarker} ${groove.name}`)) {
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
      const metadata: ScheduledGroove = {
        grooveName: groove.name,
        schedule: groove.schedule,
        agent: agentId,
        enabled: true,
      };
      yield* Effect.tryPromise(() => fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2)));
    }.bind(this));
  }

  unschedule(grooveName: string): Effect.Effect<void, Error> {
    return Effect.gen(function* (this: CronScheduler) {
      const metadataPath = this.getMetadataPath(grooveName);

      // Get current crontab
      const crontab = yield* this.getCurrentCrontab();

      // Remove entry for this workflow
      const lines = crontab.split("\n");
      const filtered: string[] = [];
      let skipNext = false;
      for (const line of lines) {
        if (line.includes(`${this.cronMarker} ${grooveName}`)) {
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

  listScheduled(): Effect.Effect<readonly ScheduledGroove[], Error> {
    return listScheduledFromMetadataFiles();
  }

  isScheduled(grooveName: string): Effect.Effect<boolean, Error> {
    return isScheduledByMetadata(grooveName);
  }
}

/**
 * Unsupported platform scheduler (no-op).
 */
class UnsupportedScheduler implements SchedulerService {
  getSchedulerType(): "launchd" | "cron" | "unsupported" {
    return "unsupported";
  }

  schedule(_workflow: GrooveMetadata, _agentId: string): Effect.Effect<void, Error> {
    return Effect.fail(
      new Error("Scheduling is not supported on this platform. Supported: macOS, Linux."),
    );
  }

  unschedule(_grooveName: string): Effect.Effect<void, Error> {
    return Effect.fail(
      new Error("Scheduling is not supported on this platform. Supported: macOS, Linux."),
    );
  }

  listScheduled(): Effect.Effect<readonly ScheduledGroove[], Error> {
    return Effect.succeed([]);
  }

  isScheduled(_grooveName: string): Effect.Effect<boolean, Error> {
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

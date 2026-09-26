/**
 * `SchedulerService`: installs workflow schedules either with the host OS scheduler
 * (launchd on macOS, cron on Linux) or, when configured, as inert metadata that
 * Jazz's in-process daemon ticker fires.
 *
 * A workflow is a process definition; a schedule is one binding of that workflow to a
 * cron expression and an agent. One workflow can carry several schedules, told apart by
 * a label, so the same weekly recap can also run monthly. Every schedule is identified
 * as `<workflow>/<label>` — in launchd labels, crontab markers, metadata files, and on
 * the command line — and `default` is the label of the frontmatter `schedule:` cron.
 *
 * Every implementation records intent to `~/.jazz/schedules/<workflow>.<label>.json`;
 * they differ only in which OS artifact, if any, they install next to it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Option } from "effect";
import * as plist from "plist";
import { toError } from "@/core/utils/errors";
import { AgentConfigServiceTag } from "../interfaces/agent-config";
import type { SchedulerMode } from "../types/config";
import { describeCronSchedule, isValidCronExpression } from "../utils/cron";
import { getGlobalUserDataDirectory } from "../utils/paths";
import { getJazzSchedulerInvocation } from "../utils/runtime";
import { execCommand, execCommandWithStdin } from "../utils/shell";

/** Label of the schedule installed from a workflow's own `schedule:` frontmatter. */
export const DEFAULT_SCHEDULE_LABEL = "default";

/** Labels become file names and launchd labels, so they stay plain slugs. */
export const VALID_SCHEDULE_LABEL = /^[a-z0-9][a-z0-9-]*$/;

/**
 * One installed schedule of a workflow.
 */
export interface ScheduledWorkflow {
  readonly workflowName: string;
  /** Tells several schedules of one workflow apart; `default` for the frontmatter cron. */
  readonly label: string;
  /** Cron expression this schedule fires on. */
  readonly schedule: string;
  readonly agent: string; // Agent ID to use for this scheduled workflow
  readonly enabled: boolean;
  readonly runAtLoad?: boolean; // Whether launchd should run the workflow on login/wake
  readonly scheduledAt?: string; // ISO timestamp of when the schedule was installed (used by --scheduled guard)
  readonly lastRun?: string;
  readonly nextRun?: string;
}

/**
 * What it takes to install one schedule. Deliberately not `WorkflowMetadata`: the
 * scheduler only needs the name, and the cron may not be the workflow's own.
 */
export interface ScheduleRequest {
  readonly workflowName: string;
  readonly label: string;
  readonly schedule: string;
  readonly agent: string;
  /** Whether launchd should run the workflow on login/wake (macOS only). Defaults to false. */
  readonly runAtLoad?: boolean;
}

/** The id a schedule is addressed by everywhere: `<workflow>/<label>`. */
export function scheduleId(entry: Pick<ScheduledWorkflow, "workflowName" | "label">): string {
  return `${entry.workflowName}/${entry.label}`;
}

/**
 * Split `<workflow>/<label>` back into its parts. A bare workflow name is accepted and
 * comes back without a label, so callers can offer a choice among that workflow's schedules.
 */
export function parseScheduleId(id: string): { workflowName: string; label?: string } {
  const separator = id.indexOf("/");
  if (separator === -1) return { workflowName: id };
  const label = id.slice(separator + 1);
  return { workflowName: id.slice(0, separator), ...(label.length > 0 && { label }) };
}

/**
 * A label for a cron the user did not name: its English description as a slug, so
 * `jazz workflow scheduled` reads `merged-pr-recap/monthly-on-day-1-at-09-00`.
 */
export function deriveScheduleLabel(cron: string): string {
  const source = describeCronSchedule(cron) ?? cron.replace(/\*/g, "any");
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "custom";
}

/**
 * Service for managing workflow schedules using system schedulers.
 */
export interface SchedulerService {
  /**
   * Install one schedule. Installing an id that already exists replaces it.
   * @returns The stored schedule, including its `scheduledAt` timestamp
   */
  readonly schedule: (request: ScheduleRequest) => Effect.Effect<ScheduledWorkflow, Error>;

  /**
   * Remove one schedule by id (`<workflow>/<label>`).
   */
  readonly unschedule: (id: string) => Effect.Effect<void, Error>;

  /**
   * List every installed schedule, across all workflows.
   */
  readonly listScheduled: () => Effect.Effect<readonly ScheduledWorkflow[], Error>;

  /**
   * Check whether a schedule id is installed.
   */
  readonly isScheduled: (id: string) => Effect.Effect<boolean, Error>;

  /**
   * Get the scheduler type being used (launchd, cron, etc.)
   */
  readonly getSchedulerType: () => "launchd" | "cron" | "in-process" | "unsupported";
}

export const SchedulerServiceTag = Context.GenericTag<SchedulerService>("SchedulerService");

/**
 * Get the directory for storing schedule metadata.
 * Always uses ~/.jazz/schedules so launchd/cron jobs find it when they run.
 */
function getSchedulesDirectory(): string {
  return path.join(getGlobalUserDataDirectory(), "schedules");
}

/**
 * Escape a string for safe use in shell commands.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
export function escapeShellArg(arg: string): string {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a PATH string for the launchd environment.
 *
 * launchd jobs start with a minimal environment that typically lacks the
 * user's shell PATH, so tools like `node` or `bun` are not found.
 * This function captures the current process PATH (at schedule time) and
 * appends common tool installation directories as fallbacks.
 *
 * NOTE: If PATH-related logic is added to the cron scheduler (e.g. a PATH=
 * prefix in the crontab entry), keep the fallback directory list here in sync.
 */
export function getLaunchdPath(): string {
  const currentPath = process.env["PATH"] ?? "";
  const homeDir = os.homedir();
  const fallbackDirs = [
    path.join(homeDir, ".bun", "bin"),
    path.join(homeDir, ".local", "share", "pnpm"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  const seen = new Set<string>();
  const resultDirs: string[] = [];

  const appendUnique = (value: string) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    resultDirs.push(normalized);
  };

  currentPath.split(":").forEach(appendUnique);
  fallbackDirs.forEach(appendUnique);

  return resultDirs.join(":");
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
      `Invalid cron value "${value}" in ${fieldName} field. ` + `Expected a simple integer or "*".`,
    );
  }

  const parsed = parseInt(value, 10);

  // parseInt should not return NaN at this point given our regex check,
  // but we validate anyway for safety
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid cron value "${value}" in ${fieldName} field. ` + `Expected a simple integer or "*".`,
    );
  }

  return parsed;
}

/**
 * Convert a cron expression to a launchd schedule dictionary.
 * Supports both 5-field (minute hour day month weekday) and 6-field (second minute hour day month weekday) format.
 *
 * NOTE: launchd only supports simple integer values or wildcards for schedule fields.
 * Complex cron features like steps, ranges, and lists are NOT supported
 * and will throw an error.
 */
function cronToLaunchdSchedule(
  cron: string,
): { Minute?: number; Hour?: number; Day?: number; Month?: number; Weekday?: number }[] {
  const parts = cron.trim().split(/\s+/);
  // Accept 5 or 6 fields; if 6, the first is seconds (we use the rest)
  if (parts.length === 6) {
    parts.shift(); // drop seconds
  }
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${cron}. Expected 5 or 6 fields.`);
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
 * The `jazz workflow run` invocation an OS scheduler fires for one schedule.
 */
function scheduledRunArguments(
  entry: ScheduleRequest,
  jazzInvocation: readonly string[],
): readonly string[] {
  return [
    ...jazzInvocation,
    "--output",
    "quiet",
    "workflow",
    "run",
    entry.workflowName,
    "--agent",
    entry.agent,
    "--auto-approve",
    "--scheduled",
    "--schedule",
    scheduleId(entry),
  ];
}

function launchdLabel(id: string): string {
  return `com.jazz.workflow.${id.replace("/", ".")}`;
}

/**
 * Generate a launchd plist file content.
 */
function generateLaunchdPlist(entry: ScheduleRequest, jazzInvocation: readonly string[]): string {
  const schedule = cronToLaunchdSchedule(entry.schedule);
  const logDir = path.join(getGlobalUserDataDirectory(), "logs");
  const id = scheduleId(entry);

  // Wrap in bash -c to print a timestamped header before exec'ing the real command.
  // This ensures logs contain a timestamp even when the jazz process crashes early.
  const commandString = scheduledRunArguments(entry, jazzInvocation).map(escapeShellArg).join(" ");
  // Escape for double-quote context: \, ", $, and backticks are special in double quotes
  const safeId = id.replace(/[\\"$`]/g, "\\$&");
  // $(date ...) uses $() not ${} so JS template literals leave it for bash to expand
  const header = `[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] launchd starting: ${safeId}`;
  const wrappedArgs = [
    "/bin/bash",
    "-c",
    `echo "${header}"; echo "${header}" >&2; exec ${commandString}`,
  ];

  const plistObject = {
    Label: launchdLabel(id),
    ProgramArguments: wrappedArgs,
    StartCalendarInterval: schedule,
    StandardOutPath: `${logDir}/${entry.workflowName}.log`,
    StandardErrorPath: `${logDir}/${entry.workflowName}.error.log`,
    RunAtLoad: entry.runAtLoad ?? false,
    EnvironmentVariables: {
      PATH: getLaunchdPath(),
    },
  };

  return plist.build(plistObject);
}

const CRON_MARKER = "# Jazz schedule:";
/** Marker written by versions that knew one schedule per workflow. Removed on migration. */
const LEGACY_CRON_MARKER = "# Jazz workflow:";

/**
 * Generate a crontab entry for a schedule.
 * Uses shell escaping to prevent command injection.
 */
function generateCrontabEntry(entry: ScheduleRequest, jazzInvocation: readonly string[]): string {
  const logDir = path.join(getGlobalUserDataDirectory(), "logs");
  const escapedLogPath = escapeShellArg(`${logDir}/${entry.workflowName}.log`);
  const command = scheduledRunArguments(entry, jazzInvocation)
    .map((token) => escapeShellArg(token))
    .join(" ");

  return `${CRON_MARKER} ${scheduleId(entry).replace(/\n/g, " ")}
${entry.schedule} ${command} >> ${escapedLogPath} 2>&1`;
}

/**
 * Drop the marker line carrying `marker key` and the crontab line right after it.
 */
function removeCrontabEntry(crontab: string, marker: string, key: string): string {
  const filtered: string[] = [];
  let skipNext = false;
  for (const line of crontab.split("\n")) {
    if (line.includes(`${marker} ${key}`)) {
      skipNext = true;
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    filtered.push(line);
  }
  return filtered.join("\n");
}

/** A metadata file on disk: its parsed schedule and whether it predates labels. */
interface StoredSchedule {
  readonly entry: ScheduledWorkflow;
  readonly file: string;
  readonly legacy: boolean;
}

/**
 * Parse and validate a ScheduledWorkflow from JSON content.
 * Returns null if the content is invalid or missing required fields. A record with no
 * label was written before schedules had one; it reads as `default` and is flagged so
 * the scheduler can reinstall it under its new id.
 */
function parseScheduledWorkflow(
  content: string,
): { entry: ScheduledWorkflow; legacy: boolean } | null {
  try {
    const parsed = JSON.parse(content) as Partial<ScheduledWorkflow>;

    if (typeof parsed.workflowName !== "string" || typeof parsed.schedule !== "string") {
      return null;
    }

    const legacy = typeof parsed.label !== "string";
    return {
      legacy,
      entry: {
        workflowName: parsed.workflowName,
        label: legacy ? DEFAULT_SCHEDULE_LABEL : parsed.label,
        schedule: parsed.schedule,
        agent: typeof parsed.agent === "string" ? parsed.agent : "default",
        enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
        ...(typeof parsed.runAtLoad === "boolean" && { runAtLoad: parsed.runAtLoad }),
        ...(typeof parsed.scheduledAt === "string" && { scheduledAt: parsed.scheduledAt }),
        ...(typeof parsed.lastRun === "string" && { lastRun: parsed.lastRun }),
        ...(typeof parsed.nextRun === "string" && { nextRun: parsed.nextRun }),
      },
    };
  } catch {
    return null;
  }
}

function readStoredSchedules(): Effect.Effect<readonly StoredSchedule[], Error> {
  return Effect.gen(function* () {
    const schedulesDir = getSchedulesDirectory();
    yield* Effect.tryPromise({
      try: () => fs.mkdir(schedulesDir, { recursive: true }),
      catch: toError,
    });
    const files = yield* Effect.tryPromise({ try: () => fs.readdir(schedulesDir), catch: toError });

    const stored: StoredSchedule[] = [];
    for (const name of files.filter((f) => f.endsWith(".json"))) {
      const file = path.join(schedulesDir, name);
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(file, "utf-8"),
        catch: toError,
      }).pipe(Effect.catchAll(() => Effect.succeed(null)));
      if (content === null) continue;
      const parsed = parseScheduledWorkflow(content);
      if (parsed) stored.push({ entry: parsed.entry, file, legacy: parsed.legacy });
    }
    return stored;
  });
}

/**
 * Everything the three schedulers share: the metadata files under `~/.jazz/schedules/`,
 * validation, listing, and the one-time migration of label-less records. Subclasses
 * install and remove the OS artifact for a schedule, if their scheduler has one.
 */
abstract class MetadataScheduler implements SchedulerService {
  abstract getSchedulerType(): "launchd" | "cron" | "in-process" | "unsupported";

  /** Install whatever the host scheduler needs to fire this schedule. */
  protected abstract installArtifact(entry: ScheduleRequest): Effect.Effect<void, Error>;
  /** Remove the artifact for a schedule id. Must succeed when nothing is installed. */
  protected abstract removeArtifact(id: string): Effect.Effect<void, Error>;
  /** Remove the artifact a pre-label version installed for `workflowName`. */
  protected abstract removeLegacyArtifact(workflowName: string): Effect.Effect<void, Error>;

  private metadataPath(entry: Pick<ScheduledWorkflow, "workflowName" | "label">): string {
    return path.join(getSchedulesDirectory(), `${entry.workflowName}.${entry.label}.json`);
  }

  schedule(request: ScheduleRequest): Effect.Effect<ScheduledWorkflow, Error> {
    return Effect.gen(
      function* (this: MetadataScheduler) {
        const schedule = request.schedule.trim();
        if (schedule.length === 0) {
          return yield* Effect.fail(
            new Error(`Schedule ${scheduleId(request)} has no cron expression`),
          );
        }
        if (!isValidCronExpression(schedule)) {
          return yield* Effect.fail(
            new Error(`Schedule ${scheduleId(request)} has invalid cron expression: ${schedule}`),
          );
        }
        if (!VALID_SCHEDULE_LABEL.test(request.label)) {
          return yield* Effect.fail(
            new Error(
              `"${request.label}" is not a valid schedule label: use lowercase letters, digits, and hyphens`,
            ),
          );
        }

        const entry: ScheduleRequest = { ...request, schedule };
        yield* Effect.tryPromise({
          try: () => fs.mkdir(getSchedulesDirectory(), { recursive: true }),
          catch: toError,
        });
        yield* Effect.tryPromise({
          try: () => fs.mkdir(path.join(getGlobalUserDataDirectory(), "logs"), { recursive: true }),
          catch: toError,
        });

        yield* this.installArtifact(entry);

        const stored: ScheduledWorkflow = {
          workflowName: entry.workflowName,
          label: entry.label,
          schedule,
          agent: entry.agent,
          enabled: true,
          runAtLoad: entry.runAtLoad ?? false,
          scheduledAt: new Date().toISOString(),
        };
        yield* Effect.tryPromise({
          try: () => fs.writeFile(this.metadataPath(stored), JSON.stringify(stored, null, 2)),
          catch: toError,
        });
        return stored;
      }.bind(this),
    );
  }

  unschedule(id: string): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: MetadataScheduler) {
        const { workflowName, label } = parseScheduleId(id);
        yield* this.removeArtifact(id);
        yield* Effect.tryPromise({
          try: () =>
            fs.unlink(this.metadataPath({ workflowName, label: label ?? DEFAULT_SCHEDULE_LABEL })),
          catch: toError,
        }).pipe(Effect.catchAll(() => Effect.void));
      }.bind(this),
    );
  }

  listScheduled(): Effect.Effect<readonly ScheduledWorkflow[], Error> {
    return Effect.gen(
      function* (this: MetadataScheduler) {
        const stored = yield* readStoredSchedules();
        const legacy = stored.filter((record) => record.legacy);
        if (legacy.length === 0) {
          return stored.map((record) => record.entry);
        }
        for (const record of legacy) {
          yield* this.migrateLegacy(record).pipe(Effect.catchAll(() => Effect.void));
        }
        return (yield* readStoredSchedules())
          .filter((record) => !record.legacy)
          .map((record) => record.entry);
      }.bind(this),
    );
  }

  isScheduled(id: string): Effect.Effect<boolean, Error> {
    const target = parseScheduleId(id);
    return this.listScheduled().pipe(
      Effect.map((entries) =>
        entries.some(
          (entry) =>
            entry.workflowName === target.workflowName &&
            entry.label === (target.label ?? DEFAULT_SCHEDULE_LABEL),
        ),
      ),
    );
  }

  /**
   * Reinstall a pre-label schedule as `<workflow>/default` and remove what the old version
   * left behind, so a job keyed by the bare workflow name never keeps firing beside its
   * replacement.
   */
  private migrateLegacy(record: StoredSchedule): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: MetadataScheduler) {
        const { entry } = record;
        yield* this.removeLegacyArtifact(entry.workflowName);
        yield* Effect.tryPromise({ try: () => fs.unlink(record.file), catch: toError }).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* this.schedule({
          workflowName: entry.workflowName,
          label: DEFAULT_SCHEDULE_LABEL,
          schedule: entry.schedule,
          agent: entry.agent,
          ...(entry.runAtLoad !== undefined && { runAtLoad: entry.runAtLoad }),
        });
      }.bind(this),
    );
  }
}

/**
 * macOS launchd implementation of SchedulerService.
 */
class LaunchdScheduler extends MetadataScheduler {
  private readonly launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");

  getSchedulerType(): "launchd" {
    return "launchd";
  }

  private plistPath(label: string): string {
    return path.join(this.launchAgentsDir, `${label}.plist`);
  }

  private unloadAndRemove(plistPath: string): Effect.Effect<void, Error> {
    return Effect.gen(function* () {
      yield* execCommand("launchctl", ["unload", plistPath]).pipe(
        Effect.catchAll(() => Effect.void),
      );
      yield* Effect.tryPromise({ try: () => fs.unlink(plistPath), catch: toError }).pipe(
        Effect.catchAll(() => Effect.void),
      );
    });
  }

  protected installArtifact(entry: ScheduleRequest): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: LaunchdScheduler) {
        const jazzInvocation = yield* getJazzSchedulerInvocation();
        const plistContent = generateLaunchdPlist(entry, jazzInvocation);
        const plistPath = this.plistPath(launchdLabel(scheduleId(entry)));

        yield* Effect.tryPromise({
          try: () => fs.mkdir(this.launchAgentsDir, { recursive: true }),
          catch: toError,
        });
        // Unload existing job if present (ignore errors)
        yield* execCommand("launchctl", ["unload", plistPath]).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.tryPromise({
          try: () => fs.writeFile(plistPath, plistContent, "utf-8"),
          catch: toError,
        });
        yield* execCommand("launchctl", ["load", plistPath]);
      }.bind(this),
    );
  }

  protected removeArtifact(id: string): Effect.Effect<void, Error> {
    return this.unloadAndRemove(this.plistPath(launchdLabel(id)));
  }

  protected removeLegacyArtifact(workflowName: string): Effect.Effect<void, Error> {
    return this.unloadAndRemove(this.plistPath(`com.jazz.workflow.${workflowName}`));
  }
}

/**
 * Linux cron implementation of SchedulerService.
 */
class CronScheduler extends MetadataScheduler {
  getSchedulerType(): "cron" {
    return "cron";
  }

  private getCurrentCrontab(): Effect.Effect<string, Error> {
    return execCommand("crontab", ["-l"]).pipe(
      Effect.catchAll(() => Effect.succeed("")), // No crontab returns error
    );
  }

  private setCrontab(content: string): Effect.Effect<void, Error> {
    return execCommandWithStdin("crontab", ["-"], content);
  }

  protected installArtifact(entry: ScheduleRequest): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: CronScheduler) {
        const jazzInvocation = yield* getJazzSchedulerInvocation();
        const crontab = yield* this.getCurrentCrontab();
        const withoutOld = removeCrontabEntry(crontab, CRON_MARKER, scheduleId(entry));
        yield* this.setCrontab(`${withoutOld}\n${generateCrontabEntry(entry, jazzInvocation)}`);
      }.bind(this),
    );
  }

  protected removeArtifact(id: string): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: CronScheduler) {
        const crontab = yield* this.getCurrentCrontab();
        yield* this.setCrontab(removeCrontabEntry(crontab, CRON_MARKER, id));
      }.bind(this),
    );
  }

  protected removeLegacyArtifact(workflowName: string): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: CronScheduler) {
        const crontab = yield* this.getCurrentCrontab();
        yield* this.setCrontab(removeCrontabEntry(crontab, LEGACY_CRON_MARKER, workflowName));
      }.bind(this),
    );
  }
}

/**
 * In-process scheduler: writes only the metadata file, no OS artifact.
 *
 * Actually running a due schedule is the daemon's job (`jazz daemon`'s ticker), not this
 * class's. That split matters: a container with no cron/launchd binary can still register a
 * schedule, and "in process" only differs from the other two implementations in who does
 * the waking.
 *
 * Opt-in via `JAZZ_SCHEDULER=in-process`, never the platform default: a schedule written this
 * way is inert unless something is running the ticker, and defaulting to it would silently
 * stop workflows firing for anyone not running `jazz daemon`.
 */
export class InProcessScheduler extends MetadataScheduler {
  getSchedulerType(): "in-process" {
    return "in-process";
  }

  protected installArtifact(): Effect.Effect<void, Error> {
    return Effect.void;
  }

  protected removeArtifact(): Effect.Effect<void, Error> {
    return Effect.void;
  }

  protected removeLegacyArtifact(): Effect.Effect<void, Error> {
    return Effect.void;
  }
}

/**
 * Unsupported platform scheduler (no-op).
 */
class UnsupportedScheduler implements SchedulerService {
  getSchedulerType(): "unsupported" {
    return "unsupported";
  }

  schedule(_request: ScheduleRequest): Effect.Effect<ScheduledWorkflow, Error> {
    return Effect.fail(
      new Error("Scheduling is not supported on this platform. Supported: macOS, Linux."),
    );
  }

  unschedule(_id: string): Effect.Effect<void, Error> {
    return Effect.fail(
      new Error("Scheduling is not supported on this platform. Supported: macOS, Linux."),
    );
  }

  listScheduled(): Effect.Effect<readonly ScheduledWorkflow[], Error> {
    return Effect.succeed([]);
  }

  isScheduled(_id: string): Effect.Effect<boolean, Error> {
    return Effect.succeed(false);
  }
}

/**
 * Create the appropriate scheduler implementation for the current platform.
 *
 * `mode === "in-process"` is an always-on-host mode selected by config or the
 * `JAZZ_SCHEDULER` override; otherwise the platform scheduler stays the default.
 */
function createScheduler(mode: SchedulerMode): SchedulerService {
  if (mode === "in-process") {
    return new InProcessScheduler();
  }

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
export const SchedulerServiceLayer = Layer.effect(
  SchedulerServiceTag,
  Effect.gen(function* () {
    const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
    const appConfig = Option.isSome(configServiceOption)
      ? yield* configServiceOption.value.appConfig
      : undefined;
    const mode =
      process.env["JAZZ_SCHEDULER"] === "in-process" || appConfig?.scheduler?.mode === "in-process"
        ? "in-process"
        : "auto";
    return createScheduler(mode);
  }),
);

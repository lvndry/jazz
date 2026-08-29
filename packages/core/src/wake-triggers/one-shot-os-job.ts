/**
 * Shared mechanics behind installing and removing a one-shot OS job — a launchd plist on macOS,
 * a one-shot `at` job on Linux — for a single `fireAt` instant. Both `wake-trigger-os-scheduler.ts`
 * (resume a conversation) and `reminder-os-scheduler.ts` (notify a person) are "install a real OS
 * job that runs one jazz command at a future timestamp"; they differ only in the label prefix,
 * log file name, and program args passed to that command, which is why this module is
 * parameterized rather than duplicated per record type.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Option } from "effect";
import * as plist from "plist";
import { AgentConfigServiceTag } from "../interfaces/agent-config";
import type { SchedulerMode } from "../types/config";
import { escapeShellArg, getLaunchdPath } from "../workflows/scheduler-service";
import { getGlobalUserDataDirectory } from "./../utils/paths";
import { getJazzSchedulerInvocation } from "./../utils/runtime";
import { execCommand, execCommandWithStdinCapturingOutput } from "./../utils/shell";

export interface OneShotOsJobResult {
  readonly osSchedulerJobId?: string;
}

export interface OneShotOsScheduler {
  readonly getType: () => "launchd" | "at" | "in-process" | "unsupported";
  readonly scheduleFire: (
    agentId: string,
    itemId: string,
    fireAt: number,
  ) => Effect.Effect<OneShotOsJobResult, Error>;
  readonly cancelFire: (
    agentId: string,
    itemId: string,
    osSchedulerJobId: string | undefined,
  ) => Effect.Effect<void, Error>;
}

export interface OneShotOsSchedulerConfig {
  /** launchd `Label` prefix, e.g. `com.jazz.trigger` or `com.jazz.reminder`. */
  readonly labelPrefix: string;
  /** Prefix for the launchd stdout/stderr log file names. */
  readonly logNamePrefix: string;
  /** Builds the jazz CLI args to run when the job fires, given the agent and item id. */
  readonly buildProgramArgs: (agentId: string, itemId: string) => readonly string[];
}

const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");

function jobLabel(config: OneShotOsSchedulerConfig, agentId: string, itemId: string): string {
  return `${config.labelPrefix}.${agentId}.${itemId}`;
}

function jobPlistPath(config: OneShotOsSchedulerConfig, agentId: string, itemId: string): string {
  return path.join(launchAgentsDir, `${jobLabel(config, agentId, itemId)}.plist`);
}

/**
 * macOS implementation: one launchd plist per item, loaded with a `StartCalendarInterval`
 * computed from `fireAt`'s local time components.
 */
class LaunchdOneShotScheduler implements OneShotOsScheduler {
  constructor(private readonly config: OneShotOsSchedulerConfig) {}

  getType(): "launchd" | "at" | "in-process" | "unsupported" {
    return "launchd";
  }

  scheduleFire(
    agentId: string,
    itemId: string,
    fireAt: number,
  ): Effect.Effect<OneShotOsJobResult, Error> {
    return Effect.gen(
      function* (this: LaunchdOneShotScheduler) {
        const jazzInvocation = yield* getJazzSchedulerInvocation();
        const programArgs = [...jazzInvocation, ...this.config.buildProgramArgs(agentId, itemId)];

        // Wrap in bash -c to print a timestamped header before exec'ing the real command,
        // the same approach `generateLaunchdPlist` uses for workflows, so logs carry a
        // timestamp even if the jazz process crashes before writing anything itself.
        const commandString = programArgs.map(escapeShellArg).join(" ");
        const header = `[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] launchd firing ${this.config.logNamePrefix}: ${itemId}`;
        const wrappedArgs = [
          "/bin/bash",
          "-c",
          `echo "${header}"; echo "${header}" >&2; exec ${commandString}`,
        ];

        const fireDate = new Date(fireAt);
        const logDir = path.join(getGlobalUserDataDirectory(), "logs");

        // StartCalendarInterval has no Year key — a plist left behind would in theory refire
        // a year later. In practice this never happens: the fired command unloads and deletes
        // its own plist immediately after running, whether the run succeeded or not.
        const plistObject = {
          Label: jobLabel(this.config, agentId, itemId),
          ProgramArguments: wrappedArgs,
          StartCalendarInterval: {
            Minute: fireDate.getMinutes(),
            Hour: fireDate.getHours(),
            Day: fireDate.getDate(),
            Month: fireDate.getMonth() + 1,
          },
          StandardOutPath: `${logDir}/${this.config.logNamePrefix}-${itemId}.log`,
          StandardErrorPath: `${logDir}/${this.config.logNamePrefix}-${itemId}.error.log`,
          RunAtLoad: false,
          EnvironmentVariables: {
            PATH: getLaunchdPath(),
          },
        };
        const plistContent = plist.build(plistObject);
        const plistFilePath = jobPlistPath(this.config, agentId, itemId);

        yield* Effect.tryPromise({
          try: () => fs.mkdir(launchAgentsDir, { recursive: true }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
        yield* Effect.tryPromise({
          try: () => fs.mkdir(logDir, { recursive: true }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });

        // Unload a stale job with the same label first, ignoring errors (there usually isn't
        // one — item ids are fresh per registration).
        yield* execCommand("launchctl", ["unload", plistFilePath]).pipe(
          Effect.catchAll(() => Effect.void),
        );

        yield* Effect.tryPromise({
          try: () => fs.writeFile(plistFilePath, plistContent, "utf-8"),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });

        yield* execCommand("launchctl", ["load", plistFilePath]);

        return {};
      }.bind(this),
    );
  }

  cancelFire(agentId: string, itemId: string): Effect.Effect<void, Error> {
    return Effect.gen(
      function* (this: LaunchdOneShotScheduler) {
        const plistFilePath = jobPlistPath(this.config, agentId, itemId);
        yield* execCommand("launchctl", ["unload", plistFilePath]).pipe(
          Effect.catchAll(() => Effect.void),
        );
        yield* Effect.tryPromise({
          try: () => fs.unlink(plistFilePath),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.catchAll(() => Effect.void));
      }.bind(this),
    );
  }
}

/** Parse the job id out of `at`'s "job 3 at Thu Aug 29 06:00:00 2026" line. */
function parseAtJobId(output: string): string | undefined {
  const match = /job\s+(\d+)/i.exec(output);
  return match?.[1];
}

/** Format `fireAt` as `at -t`'s local-time `YYYYMMDDHHmm.ss` timestamp. */
function formatAtTimestamp(fireAt: number): string {
  const date = new Date(fireAt);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());
  return `${year}${month}${day}${hour}${minute}.${second}`;
}

/**
 * Linux implementation: one one-shot `at` job per item. `createOneShotOsScheduler` only selects
 * this when the `at` binary is actually present.
 */
class AtOneShotScheduler implements OneShotOsScheduler {
  constructor(private readonly config: OneShotOsSchedulerConfig) {}

  getType(): "launchd" | "at" | "in-process" | "unsupported" {
    return "at";
  }

  scheduleFire(
    agentId: string,
    itemId: string,
    fireAt: number,
  ): Effect.Effect<OneShotOsJobResult, Error> {
    return Effect.gen(
      function* (this: AtOneShotScheduler) {
        const jazzInvocation = yield* getJazzSchedulerInvocation();
        const programArgs = [...jazzInvocation, ...this.config.buildProgramArgs(agentId, itemId)];
        const commandLine = programArgs.map(escapeShellArg).join(" ");
        const timestamp = formatAtTimestamp(fireAt);

        const result = yield* execCommandWithStdinCapturingOutput(
          "at",
          ["-t", timestamp],
          commandLine,
        );

        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            new Error(`at failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`),
          );
        }

        // `at` prints the job id to stderr, not stdout, even on success. When it can't be
        // parsed, cancelFire below just becomes a no-op — the in-process ticker or the stale
        // `at` job remain the safety net, so this never blocks registration.
        const jobId = parseAtJobId(result.stderr) ?? parseAtJobId(result.stdout);
        return jobId !== undefined ? { osSchedulerJobId: jobId } : {};
      }.bind(this),
    );
  }

  cancelFire(
    _agentId: string,
    _itemId: string,
    osSchedulerJobId: string | undefined,
  ): Effect.Effect<void, Error> {
    if (osSchedulerJobId === undefined) {
      return Effect.void;
    }
    return execCommand("atrm", [osSchedulerJobId]).pipe(Effect.catchAll(() => Effect.void));
  }
}

/**
 * No-op scheduler: preserves ticker-only behavior. Used when no host scheduler is available, or
 * when `JAZZ_SCHEDULER=in-process` opts out of installing OS-level jobs. Also used, unchanged,
 * for genuinely unsupported platforms — both cases never block scheduling.
 */
class NoopOneShotScheduler implements OneShotOsScheduler {
  constructor(private readonly type: "in-process" | "unsupported") {}

  getType(): "launchd" | "at" | "in-process" | "unsupported" {
    return this.type;
  }

  scheduleFire(): Effect.Effect<OneShotOsJobResult, Error> {
    return Effect.succeed({});
  }

  cancelFire(): Effect.Effect<void, Error> {
    return Effect.void;
  }
}

/**
 * Resolve the scheduler mode from `JAZZ_SCHEDULER` and, when the config service is available,
 * `appConfig.scheduler.mode` — the same precedence `SchedulerServiceLayer` uses for workflow
 * scheduling.
 */
function resolveSchedulerMode(): Effect.Effect<SchedulerMode> {
  return Effect.gen(function* () {
    const configServiceOption = yield* Effect.serviceOption(AgentConfigServiceTag);
    const appConfig = Option.isSome(configServiceOption)
      ? yield* configServiceOption.value.appConfig
      : undefined;
    return process.env["JAZZ_SCHEDULER"] === "in-process" ||
      appConfig?.scheduler?.mode === "in-process"
      ? "in-process"
      : "auto";
  });
}

/**
 * Create the appropriate `OneShotOsScheduler` for the current platform and configuration.
 *
 * Never throws and never blocks: an unavailable `at` binary, or any other detection failure,
 * falls back to the in-process scheduler rather than failing registration of whatever this
 * backs (a wake trigger or a reminder).
 */
export function createOneShotOsScheduler(
  config: OneShotOsSchedulerConfig,
): Effect.Effect<OneShotOsScheduler> {
  return Effect.gen(function* () {
    const mode = yield* resolveSchedulerMode();
    if (mode === "in-process") {
      return new NoopOneShotScheduler("in-process");
    }

    const platform = process.platform;

    if (platform === "darwin") {
      return new LaunchdOneShotScheduler(config);
    }

    if (platform === "linux") {
      const hasAt = yield* execCommand("which", ["at"]).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      );
      return hasAt ? new AtOneShotScheduler(config) : new NoopOneShotScheduler("in-process");
    }

    return new NoopOneShotScheduler("unsupported");
  });
}

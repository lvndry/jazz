/**
 * Operator commands for computer use (experimental).
 *
 * The commands that give an agent reach over the desktop (`acknowledge`, `grant`) and the one
 * that enumerates what is running (`apps`) refuse to run inside a process a Jazz agent started.
 * The rest only narrow or report, so anyone may run them: `revoke`, `stop`, `list`, `log`,
 * `doctor`.
 */

import { createInterface } from "node:readline/promises";
import { classifyApp, describeRefusal } from "@jazz/core/agent/tools/computer/app-policy";
import { requestStop } from "@jazz/core/agent/tools/computer/control";
import { CuaDriver } from "@jazz/core/agent/tools/computer/cua-driver";
import { runDoctor } from "@jazz/core/agent/tools/computer/doctor";
import type { ComputerDriver } from "@jazz/core/agent/tools/computer/driver";
import {
  checkDriverPin,
  computerUseSupported,
  DRIVER_MISSING_MESSAGE,
  hashFileSha256,
  resolveDriverExecutable,
  UNSUPPORTED_PLATFORM_MESSAGE,
} from "@jazz/core/agent/tools/computer/driver-pin";
import {
  activeGrants,
  type ComputerGrant,
  DEFAULT_GRANT_EXPIRY_MS,
  DEFAULT_GRANT_IDLE_TIMEOUT_MS,
  readComputerState,
  updateComputerState,
  withAcknowledgement,
  withGrant,
  withoutGrant,
} from "@jazz/core/agent/tools/computer/grants";
import { readLedger } from "@jazz/core/agent/tools/computer/ledger";
import { createSanitizedEnv, isAgentStartedProcess } from "@jazz/core/utils/env";
import { Effect } from "effect";

const MINUTE_MS = 60 * 1000;

/** The longest a grant may last: a week, so no grant is forever. */
const MAX_GRANT_EXPIRY_MS = 7 * 24 * 60 * MINUTE_MS;

/** The shortest a grant or idle timeout may be. */
const MIN_DURATION_MS = MINUTE_MS;

/** Longest the driver's own `doctor` may run, in milliseconds. */
const DRIVER_DOCTOR_TIMEOUT_MS = 15_000;

/** Ledger entries `jazz computer log` shows unless told otherwise. */
const DEFAULT_LOG_LIMIT = 20;

const EXPERIMENTAL_NOTICE =
  "Computer use is experimental. It may change or break between releases.";

const ACKNOWLEDGEMENT_TEXT = [
  EXPERIMENTAL_NOTICE,
  "",
  "Acknowledging means you understand that:",
  "  - an agent you enable it for can read and act in the apps you grant, on this computer;",
  "  - screenshots and on-screen text are sent to your model provider;",
  "  - nothing here is an operating-system sandbox; it limits what Jazz does, not what an app can do;",
  "  - it runs only in a terminal conversation while you watch, and `jazz computer stop` ends it.",
].join("\n");

function refuseWhenAgentStarted(decision: string): boolean {
  if (!isAgentStartedProcess()) {
    return false;
  }
  process.stderr.write(
    `${decision} is your decision; this command was started by a Jazz agent, so it was refused. Run it yourself.\n`,
  );
  process.exitCode = 1;
  return true;
}

function fail(message: string): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function withinRange(
  label: string,
  milliseconds: number | undefined,
  fallback: number,
  max: number,
) {
  if (milliseconds === undefined) {
    return fallback;
  }
  if (milliseconds < MIN_DURATION_MS || milliseconds > max) {
    throw new Error(
      `${label} must be between 1 minute and ${String(Math.round(max / MINUTE_MS))} minutes.`,
    );
  }
  return milliseconds;
}

async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    return false;
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await lines.question(question)).trim().toLowerCase() === "yes";
  } finally {
    lines.close();
  }
}

/** Record that you understand what computer use does, and pin the driver build you acknowledged. */
export function acknowledgeCommand(options: { readonly yes: boolean }) {
  return Effect.gen(function* () {
    if (refuseWhenAgentStarted("Acknowledging computer use")) {
      return;
    }
    if (!computerUseSupported()) {
      fail(UNSUPPORTED_PLATFORM_MESSAGE);
      return;
    }
    const executablePath = yield* Effect.promise(() => resolveDriverExecutable());
    if (executablePath === undefined) {
      fail(DRIVER_MISSING_MESSAGE);
      return;
    }
    const sha256 = yield* Effect.promise(() => hashFileSha256(executablePath));
    const kinds = yield* Effect.promise(async () => {
      const driver = await CuaDriver.open({ executablePath });
      try {
        return await driver.capabilities();
      } finally {
        await driver.close().catch(() => undefined);
      }
    });
    const capabilityLines = [
      "Capabilities:",
      ...(kinds.length === 0 ? ["  (core actions only)"] : kinds.map((kind) => `  ${kind}`)),
    ];
    process.stdout.write(
      `${ACKNOWLEDGEMENT_TEXT}\n\nDriver: ${executablePath}\nSHA-256: ${sha256}\n${capabilityLines.join("\n")}\n\n`,
    );
    const accepted =
      options.yes || (yield* Effect.promise(() => confirm("Type yes to acknowledge: ")));
    if (!accepted) {
      fail(
        options.yes
          ? "Not acknowledged."
          : "Not acknowledged. Run this in a terminal and type yes, or pass --yes.",
      );
      return;
    }
    yield* Effect.promise(() =>
      updateComputerState((state) =>
        withAcknowledgement(state, {
          acknowledgedAt: Date.now(),
          driverPath: executablePath,
          driverSha256: sha256,
        }),
      ),
    );
    process.stdout.write("Acknowledged. Grant an app with: jazz computer grant <bundle-id>\n");
  });
}

export interface GrantOptions {
  readonly expiresMs?: number | undefined;
  readonly idleMs?: number | undefined;
  readonly foreground: boolean;
  readonly name?: string | undefined;
}

/** Let agents with computer use act in one app for a limited time. */
export function grantCommand(bundleId: string, options: GrantOptions) {
  return Effect.gen(function* () {
    if (refuseWhenAgentStarted("Granting an app")) {
      return;
    }
    const state = yield* Effect.promise(() => readComputerState());
    if (state.acknowledgement === undefined) {
      fail("Run `jazz computer acknowledge` first.");
      return;
    }
    const appClass = classifyApp(bundleId);
    if (appClass === "refused") {
      fail(describeRefusal(bundleId));
      return;
    }
    const expiresAfterMs = withinRange(
      "--expires",
      options.expiresMs,
      DEFAULT_GRANT_EXPIRY_MS,
      MAX_GRANT_EXPIRY_MS,
    );
    const idleTimeoutMs = withinRange(
      "--idle",
      options.idleMs,
      DEFAULT_GRANT_IDLE_TIMEOUT_MS,
      expiresAfterMs,
    );
    const now = Date.now();
    const grant: ComputerGrant = {
      bundleId,
      ...(options.name === undefined ? {} : { name: options.name }),
      grantedAt: now,
      expiresAt: now + expiresAfterMs,
      idleTimeoutMs,
      foreground: options.foreground,
    };
    yield* Effect.promise(() => updateComputerState((current) => withGrant(current, grant)));
    process.stdout.write(
      `Granted ${bundleId} (${appClass}) until ${new Date(grant.expiresAt).toLocaleString()}; ` +
        `idle timeout ${String(Math.round(idleTimeoutMs / MINUTE_MS))} minutes; ` +
        `${options.foreground ? "may be brought to the front" : "background only"}.\n`,
    );
  });
}

/** Take back an app's grant. Takes effect on the agent's very next action. */
export function revokeCommand(bundleId: string) {
  return Effect.gen(function* () {
    const state = yield* Effect.promise(() => readComputerState());
    if (!state.grants.some((grant) => grant.bundleId === bundleId)) {
      fail(`${bundleId} is not granted.`);
      return;
    }
    yield* Effect.promise(() => updateComputerState((current) => withoutGrant(current, bundleId)));
    process.stdout.write(`Revoked ${bundleId}.\n`);
  });
}

/** Show the acknowledgement and every grant. */
export function listGrantsCommand() {
  return Effect.gen(function* () {
    const state = yield* Effect.promise(() => readComputerState());
    const now = Date.now();
    process.stdout.write(
      state.acknowledgement === undefined
        ? "Not acknowledged. Run: jazz computer acknowledge\n"
        : `Acknowledged ${new Date(state.acknowledgement.acknowledgedAt).toLocaleString()}; driver ${state.acknowledgement.driverPath}\n`,
    );
    if (state.grants.length === 0) {
      process.stdout.write("No apps are granted.\n");
      return;
    }
    const live = new Set(activeGrants(state, now).map((grant) => grant.bundleId));
    for (const grant of state.grants) {
      process.stdout.write(
        `${grant.bundleId}\t${classifyApp(grant.bundleId)}\t` +
          `${live.has(grant.bundleId) ? "until" : "expired"} ${new Date(grant.expiresAt).toLocaleString()}\t` +
          `idle ${String(Math.round(grant.idleTimeoutMs / MINUTE_MS))}m\t` +
          `${grant.foreground ? "foreground" : "background"}\n`,
      );
    }
  });
}

/** List the apps running now, with bundle ids to grant and the class each would get. */
export function appsCommand() {
  return Effect.gen(function* () {
    if (refuseWhenAgentStarted("Listing the apps on your computer")) {
      return;
    }
    const state = yield* Effect.promise(() => readComputerState());
    const pin = yield* Effect.promise(() => checkDriverPin(state.acknowledgement));
    if (!pin.ok) {
      fail(pin.reason);
      return;
    }
    const driver = yield* Effect.promise(() =>
      CuaDriver.open({ executablePath: pin.executablePath }),
    );
    try {
      const apps = yield* Effect.promise(() => driver.listApps());
      for (const app of apps.filter((candidate) => candidate.running)) {
        process.stdout.write(
          `${app.bundleId ?? "(no bundle id)"}\t${app.name}\t${classifyApp(app.bundleId)}\n`,
        );
      }
    } finally {
      yield* Effect.promise(() => driver.close());
    }
  });
}

/** Stop the run that is using the computer. Takes effect at its next action. */
export function stopCommand() {
  return Effect.gen(function* () {
    const session = yield* Effect.promise(() => requestStop());
    process.stdout.write(
      session === undefined
        ? "No run is using the computer. A run that starts now is not affected.\n"
        : `Asked the run using the computer (pid ${String(session.pid)}) to stop.\n`,
    );
  });
}

/** Show what computer use did, newest first. */
export function logCommand(options: { readonly limit?: number | undefined }) {
  return Effect.gen(function* () {
    const entries = yield* Effect.promise(() => readLedger(options.limit ?? DEFAULT_LOG_LIMIT));
    if (entries.length === 0) {
      process.stdout.write("Computer use has not done anything yet.\n");
      return;
    }
    for (const entry of entries) {
      process.stdout.write(
        `${entry.timestamp}  ${entry.outcome.padEnd(7)}  ${entry.app}  ${entry.action}${entry.target === undefined ? "" : `  ${entry.target}`}${entry.delivery === "foreground" ? "  (foreground)" : ""}\n`,
      );
    }
  });
}

async function runDriverDoctor(executablePath: string): Promise<string | undefined> {
  try {
    const child = Bun.spawn([executablePath, "doctor"], {
      stdout: "pipe",
      stderr: "pipe",
      env: createSanitizedEnv(),
      signal: AbortSignal.timeout(DRIVER_DOCTOR_TIMEOUT_MS),
    });
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const trimmed = output.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

const STATUS_MARK = { ok: "ok       ", attention: "attention", blocked: "blocked  " } as const;

/** Check that this machine and the driver are ready. Exit code 0 ready, 1 needs attention, 2 cannot run. */
export function doctorCommand() {
  return Effect.gen(function* () {
    const report = yield* Effect.promise(() =>
      runDoctor({
        openDriver: (executablePath): Promise<ComputerDriver> => CuaDriver.open({ executablePath }),
        runDriverDoctor,
      }),
    );
    for (const check of report.checks) {
      process.stdout.write(`${STATUS_MARK[check.status]}  ${check.name}: ${check.detail}\n`);
    }
    if (report.driverReport !== undefined) {
      process.stdout.write(`\nThe driver reports:\n${report.driverReport}\n`);
    }
    process.exitCode = report.exitCode;
  });
}

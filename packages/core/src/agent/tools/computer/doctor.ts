/**
 * The health check behind `jazz computer doctor`: is this machine, the driver, and the operator's
 * setup ready for computer use, and if not, what to do about it.
 *
 * Exit codes: 0 when everything is ready, 1 when computer use would start but something needs
 * attention (not acknowledged, no grants, a missing permission), and 2 when it cannot run at all
 * (an unsupported machine, no driver, or a driver that will not start).
 */

import { EXTENDED_ACTION_CAPABILITIES } from "./cua-contract";
import type { ComputerDriver } from "./driver";
import {
  computerUseSupported,
  hashFileSha256,
  resolveDriverExecutable,
  UNSUPPORTED_PLATFORM_MESSAGE,
  DRIVER_MISSING_MESSAGE,
} from "./driver-pin";
import { activeGrants, type ComputerState, readComputerState } from "./grants";

export type CheckStatus = "ok" | "attention" | "blocked";

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: 0 | 1 | 2;
  /** The driver's own report, when it produced one. */
  readonly driverReport: string | undefined;
}

export interface DoctorDependencies {
  readonly isSupported?: () => boolean;
  readonly resolveExecutable?: () => Promise<string | undefined>;
  readonly hashExecutable?: (executablePath: string) => Promise<string>;
  readonly readState?: () => Promise<ComputerState>;
  readonly openDriver: (executablePath: string) => Promise<ComputerDriver>;
  /** Runs the driver's own `doctor` command and returns what it printed, or undefined. */
  readonly runDriverDoctor?: (executablePath: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

const PERMISSION_PATTERN = /permission|not granted|not trusted|accessibility|screen recording/i;

const PERMISSION_HINT =
  "Grant Accessibility and Screen Recording to the driver app in System Settings, under Privacy & Security.";

function exitCodeFor(checks: readonly DoctorCheck[]): 0 | 1 | 2 {
  if (checks.some((check) => check.status === "blocked")) {
    return 2;
  }
  return checks.some((check) => check.status === "attention") ? 1 : 0;
}

export async function runDoctor(dependencies: DoctorDependencies): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string): void => {
    checks.push({ name, status, detail });
  };
  const finish = (driverReport?: string): DoctorReport => ({
    checks,
    exitCode: exitCodeFor(checks),
    driverReport,
  });

  if (!(dependencies.isSupported ?? computerUseSupported)()) {
    add("platform", "blocked", UNSUPPORTED_PLATFORM_MESSAGE);
    return finish();
  }
  add("platform", "ok", "macOS with Apple Silicon");

  const executablePath = await (dependencies.resolveExecutable ?? resolveDriverExecutable)();
  if (executablePath === undefined) {
    add("driver", "blocked", DRIVER_MISSING_MESSAGE);
    return finish();
  }
  const sha256 = await (dependencies.hashExecutable ?? hashFileSha256)(executablePath);
  add("driver", "ok", `${executablePath} (sha256 ${sha256.slice(0, 12)}…)`);

  const state = await (dependencies.readState ?? readComputerState)();
  if (state.acknowledgement === undefined) {
    add("acknowledgement", "attention", "Not acknowledged. Run `jazz computer acknowledge`.");
  } else if (state.acknowledgement.driverSha256 !== sha256) {
    add(
      "acknowledgement",
      "attention",
      "The driver changed since you acknowledged it. Run `jazz computer acknowledge` again.",
    );
  } else {
    add("acknowledgement", "ok", "The driver is the build you acknowledged.");
  }

  const grants = activeGrants(state, (dependencies.now ?? Date.now)());
  add(
    "grants",
    grants.length === 0 ? "attention" : "ok",
    grants.length === 0
      ? "No app is granted. Run `jazz computer grant <bundle-id>`."
      : `${String(grants.length)} app${grants.length === 1 ? "" : "s"} granted.`,
  );

  let driver: ComputerDriver;
  try {
    driver = await dependencies.openDriver(executablePath);
  } catch (error) {
    add("start", "blocked", error instanceof Error ? error.message : String(error));
    return finish();
  }
  try {
    add(
      "start",
      "ok",
      `The driver started${driver.version === null ? "" : ` (version ${driver.version})`}.`,
    );
    try {
      const apps = await driver.listApps();
      add(
        "read",
        "ok",
        `The driver sees ${String(apps.filter((app) => app.running).length)} running apps.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add(
        "read",
        "attention",
        PERMISSION_PATTERN.test(message) ? `${message} ${PERMISSION_HINT}` : message,
      );
    }
    try {
      const supported = await driver.capabilities();
      const missing = EXTENDED_ACTION_CAPABILITIES.filter(
        (capability) => !supported.includes(capability.kind),
      ).map((capability) => capability.kind);
      add(
        "capabilities",
        missing.length === 0 ? "ok" : "attention",
        missing.length === 0
          ? "The driver serves every extended action (double/triple click, drag, hover, set value)."
          : `Not supported by this driver build: ${missing.join(", ")}. Other actions still work.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      add("capabilities", "attention", message);
    }
  } finally {
    await driver.close().catch(() => undefined);
  }

  const driverReport = await dependencies.runDriverDoctor?.(executablePath);
  return finish(driverReport);
}

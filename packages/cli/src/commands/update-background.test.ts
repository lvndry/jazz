import { silentLogger } from "@jazz/core/agent/test-logger";
import { LoggerServiceTag, type LoggerService } from "@jazz/core/interfaces/logger";
import { TerminalServiceTag, type TerminalService } from "@jazz/core/interfaces/terminal";
import { UpdateCheckError, UpdateInstallError } from "@jazz/core/types/errors";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  backgroundUpdateCommand,
  isPatchUpdate,
  type BackgroundUpdateDependencies,
} from "./update";

interface Harness {
  readonly logged: string[];
  readonly terminalCalls: string[];
  readonly installs: string[];
  readonly releases: number[];
}

type CheckResult = { hasUpdate: boolean; currentVersion: string; latestVersion: string };

async function run(
  check: Effect.Effect<CheckResult, UpdateCheckError>,
  install: Effect.Effect<void, UpdateInstallError> = Effect.void,
): Promise<Harness> {
  const harness: Harness = { logged: [], terminalCalls: [], installs: [], releases: [] };
  const logger: LoggerService = {
    ...silentLogger,
    debug: (message) => Effect.sync(() => void harness.logged.push(`debug:${message}`)),
    info: (message) => Effect.sync(() => void harness.logged.push(`info:${message}`)),
    warn: (message) => Effect.sync(() => void harness.logged.push(`warn:${message}`)),
  };
  const terminal = new Proxy({} as TerminalService, {
    get: (_target, property) =>
      property === "isInteractive"
        ? false
        : () => {
            harness.terminalCalls.push(String(property));
            return Effect.void;
          },
  });
  const dependencies: BackgroundUpdateDependencies = {
    checkForUpdate: () => check,
    installUpdate: (_name, version) =>
      Effect.suspend(() => {
        harness.installs.push(version);
        return install;
      }),
    releaseInstallClaim: () => void harness.releases.push(1),
  };
  await Effect.runPromise(
    backgroundUpdateCommand(dependencies).pipe(
      Effect.provideService(LoggerServiceTag, logger),
      Effect.provideService(TerminalServiceTag, terminal),
    ),
  );
  return harness;
}

const patchUpdate: CheckResult = {
  hasUpdate: true,
  currentVersion: "0.17.6",
  latestVersion: "0.17.7",
};

describe("backgroundUpdateCommand", () => {
  test("installs a patch update silently and records it", async () => {
    const harness = await run(Effect.succeed(patchUpdate));
    expect(harness.installs).toEqual(["0.17.7"]);
    expect(harness.logged).toContain("info:Background update installed");
    expect(harness.terminalCalls).toEqual([]);
  });

  test("does nothing when already on the latest version", async () => {
    const harness = await run(
      Effect.succeed({ hasUpdate: false, currentVersion: "0.17.6", latestVersion: "0.17.6" }),
    );
    expect(harness.installs).toEqual([]);
    expect(harness.logged).toContain("debug:Background update skipped, already on latest");
  });

  test("leaves a minor release to the user", async () => {
    const harness = await run(
      Effect.succeed({ hasUpdate: true, currentVersion: "0.17.6", latestVersion: "0.18.0" }),
    );
    expect(harness.installs).toEqual([]);
    expect(harness.logged).toContain("debug:Background update skipped, release is not a patch");
  });

  test("records a failed check without installing", async () => {
    const harness = await run(Effect.fail(new UpdateCheckError({ message: "offline" })));
    expect(harness.installs).toEqual([]);
    expect(harness.logged).toContain("debug:Background update check failed");
  });

  test("records a failed install as a warning", async () => {
    const harness = await run(
      Effect.succeed(patchUpdate),
      Effect.fail(new UpdateInstallError({ message: "permission denied" })),
    );
    expect(harness.logged).toContain("warn:Background update failed");
    expect(harness.terminalCalls).toEqual([]);
  });

  test("releases the install claim whatever the outcome", async () => {
    const installed = await run(Effect.succeed(patchUpdate));
    const failedCheck = await run(Effect.fail(new UpdateCheckError({ message: "offline" })));
    const failedInstall = await run(
      Effect.succeed(patchUpdate),
      Effect.fail(new UpdateInstallError({ message: "permission denied" })),
    );
    expect(
      [installed, failedCheck, failedInstall].map((harness) => harness.releases.length),
    ).toEqual([1, 1, 1]);
  });
});

describe("isPatchUpdate", () => {
  test("accepts a patch bump and rejects minor and major bumps", () => {
    expect(isPatchUpdate("0.17.6", "0.17.7")).toBe(true);
    expect(isPatchUpdate("0.17.6", "0.18.0")).toBe(false);
    expect(isPatchUpdate("0.17.6", "1.17.7")).toBe(false);
  });
});

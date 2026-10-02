/**
 * Resolve and hash the desktop driver. First use pins the successfully started build; later
 * sessions refuse changed binaries until the operator approves the new build in conversation.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, realpath } from "node:fs/promises";
import * as path from "node:path";
import type { ComputerAcknowledgement } from "./grants";

/** Environment variable naming the driver executable, taken before searching `PATH`. */
export const DRIVER_PATH_ENV = "JAZZ_COMPUTER_DRIVER";

export const DRIVER_COMMAND = "cua-driver";

/** Computer use drives macOS on Apple Silicon only. */
export function computerUseSupported(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): boolean {
  return platform === "darwin" && architecture === "arm64";
}

export const UNSUPPORTED_PLATFORM_MESSAGE =
  "Computer use is experimental and runs on macOS with Apple Silicon only.";

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The driver executable: `JAZZ_COMPUTER_DRIVER` when set, else `cua-driver` on `PATH`, with
 * symlinks resolved so the hash is of the real file. Undefined when there is none.
 */
export async function resolveDriverExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const configured = environment[DRIVER_PATH_ENV]?.trim();
  const candidates =
    configured !== undefined && configured.length > 0
      ? [configured]
      : (environment["PATH"] ?? "")
          .split(path.delimiter)
          .filter((directory) => directory.length > 0)
          .map((directory) => path.join(directory, DRIVER_COMMAND));
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) {
      return realpath(candidate);
    }
  }
  return undefined;
}

export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

export type DriverPinCheck =
  | { readonly ok: true; readonly executablePath: string; readonly sha256: string }
  | { readonly ok: false; readonly reason: string };

export const DRIVER_INSTALL_COMMAND = `/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"`;

export const DRIVER_MISSING_MESSAGE =
  `Computer use needs the ${DRIVER_COMMAND} driver, and none was found. Unblock it one of these ways:\n` +
  `  1. Let the agent install it: call the computer_install_driver tool and approve the command it shows.\n` +
  `  2. Install it in your own terminal: ${DRIVER_INSTALL_COMMAND}\n` +
  `  3. Point at an existing build: export ${DRIVER_PATH_ENV}=/path/to/cua-driver\n` +
  "After installing, retry the computer tool. Its first successful session pins the driver build.";

/** Resolve the binary before starting a session and reject changes to an existing pin. */
export async function checkDriverPin(
  acknowledgement: ComputerAcknowledgement | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DriverPinCheck> {
  const executablePath = await resolveDriverExecutable(environment);
  if (executablePath === undefined) {
    return { ok: false, reason: DRIVER_MISSING_MESSAGE };
  }
  const sha256 = await hashFileSha256(executablePath);
  if (acknowledgement !== undefined && sha256 !== acknowledgement.driverSha256) {
    return {
      ok: false,
      reason:
        `The driver at ${executablePath} changed since its first use. ` +
        "Call computer_acknowledge_driver in this conversation to approve the new build.",
    };
  }
  return { ok: true, executablePath, sha256 };
}

/**
 * Installing the driver from inside a conversation.
 *
 * The driver is external: the in-conversation offer runs its install command only after an
 * approval showing the exact command. The first successful computer session then pins the
 * installed driver's digest.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDriverExecutable } from "./driver-pin";
import { DRIVER_INSTALL_COMMAND as DRIVER_INSTALL_COMMAND_PIN } from "./driver-pin";

/** The driver project the installer belongs to. */
export const DRIVER_INSTALLER_URL = "https://cua.ai/driver/install.sh";

/** The full command the approval shows the operator. */
export const DRIVER_INSTALL_COMMAND = DRIVER_INSTALL_COMMAND_PIN;

/** The symlink the installer creates when it manages PATH itself. */
export function defaultDriverInstallPath(): string {
  return join(homedir(), ".local", "bin", "cua-driver");
}

export const DRIVER_INSTALL_FAILED_MESSAGE = `Installing the driver failed; rerun it in your own terminal to see the output: ${DRIVER_INSTALL_COMMAND}`;

export const PERMISSIONS_PENDING_HINT =
  "macOS still asks for Accessibility or Screen Recording for the driver. Unblock it from your " +
  "own terminal: cua-driver permissions grant (System Settings → Privacy & Security → Accessibility " +
  "and Screen & System Audio Recording). It usually shows a dialog; if one already allowed it is " +
  "stale, run: tccutil reset ScreenCapture com.trycua.driver && cua-driver permissions grant. " +
  "Retry the tool after that.";

/**
 * Run the installer and wait for the binary it installs. Resolves to the resolved driver path,
 * or throws a DriverError-shaped message when it did not appear.
 */
export function installDriver(timeoutMs: number = 5 * 60 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", `curl -fsSL ${DRIVER_INSTALLER_URL} | /bin/bash`], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${join(homedir(), ".local", "bin")}:${process.env["PATH"] ?? ""}`,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${DRIVER_INSTALL_FAILED_MESSAGE} (${error.message})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      void (async () => {
        try {
          if (code !== 0) {
            const tail = output
              .split("\n")
              .filter((line) => line.trim().length > 0)
              .slice(-3)
              .join(" | ");
            throw new Error(
              `${DRIVER_INSTALL_FAILED_MESSAGE} Installer output: ${tail.length > 0 ? tail : `exit code ${String(code)}`}`,
            );
          }
          const resolved = await resolveDriverExecutable();
          if (resolved === undefined) {
            throw new Error(
              `The installer finished but ${"cua-driver"} was not found on the PATH. ` +
                `Add the installer's suggested bin directory to the PATH or set ` +
                `JAZZ_COMPUTER_DRIVER=${defaultDriverInstallPath()}, then retry.`,
            );
          }
          resolve(resolved);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  });
}

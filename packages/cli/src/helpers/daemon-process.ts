/**
 * Background jazz daemon lifecycle: pidfile under `$JAZZ_HOME`, start/stop without
 * competing with launchd/systemd. Installed services pass `--foreground` and skip this.
 */

import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";

export function daemonPidPath(port: number): string {
  return path.join(getJazzHomeDirectory(), `daemon-${String(port)}.pid`);
}

export async function writeDaemonPid(port: number, pid: number): Promise<void> {
  const file = daemonPidPath(port);
  await nodeFs.mkdir(path.dirname(file), { recursive: true });
  await nodeFs.writeFile(file, `${String(pid)}\n`, { encoding: "utf-8", mode: 0o600 });
}

export async function readDaemonPid(port: number): Promise<number | undefined> {
  try {
    const raw = await nodeFs.readFile(daemonPidPath(port), "utf-8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function clearDaemonPid(port: number): Promise<void> {
  await nodeFs.rm(daemonPidPath(port), { force: true }).catch(() => undefined);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type StopDaemonResult =
  | { readonly kind: "nothing" }
  | { readonly kind: "stopped"; readonly pid: number }
  | { readonly kind: "failed"; readonly pid: number; readonly detail: string };

/**
 * Stop the daemon for this port: prefer the pidfile, fall back to the listener on the port.
 * Idempotent — nothing running is success.
 */
export async function stopDaemonProcess(port: number): Promise<StopDaemonResult> {
  let pid = await readDaemonPid(port);
  if (pid === undefined || !isProcessAlive(pid)) {
    pid = await findListenerPid(port);
  }
  if (pid === undefined) {
    await clearDaemonPid(port);
    return { kind: "nothing" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    await clearDaemonPid(port);
    const detail = error instanceof Error ? error.message : String(error);
    if (!isProcessAlive(pid)) return { kind: "stopped", pid };
    return { kind: "failed", pid, detail };
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      await clearDaemonPid(port);
      return { kind: "stopped", pid };
    }
    await Bun.sleep(100);
  }

  if (!isProcessAlive(pid)) {
    await clearDaemonPid(port);
    return { kind: "stopped", pid };
  }
  return { kind: "failed", pid, detail: "still running after SIGTERM (5s)" };
}

/**
 * PID listening on TCP `port`, or undefined. Uses `lsof` when present (macOS/Linux).
 */
export async function findListenerPid(port: number): Promise<number | undefined> {
  try {
    const child = Bun.spawn({
      cmd: ["lsof", "-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const code = await child.exited;
    if (code !== 0) return undefined;
    for (const line of stdout.split("\n")) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function waitForDaemonHealth(
  host: string,
  port: number,
  timeoutMs = 8_000,
): Promise<boolean> {
  const probeHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${probeHost}:${String(port)}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // keep polling
    }
    await Bun.sleep(150);
  }
  return false;
}

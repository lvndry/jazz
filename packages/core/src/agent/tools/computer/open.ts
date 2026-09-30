/**
 * Starting a computer session: every check that must hold before a driver process exists.
 *
 * In order: this machine is supported, the operator acknowledged computer use and the driver is
 * the acknowledged build, and no other run holds the desktop. Only then does the driver start.
 * No apps need to be granted: the agent asks for each app on its first reach, and an active
 * grant is only a way for the operator to pre-authorize. Anything that fails stops here with a
 * message the operator can act on, and nothing is left running or locked.
 */

import * as path from "node:path";
import { storageSafeSegment } from "@/core/utils/storage-id";
import { acquireComputerLock, clearStopRequest, writeSessionInfo } from "./control";
import { CuaDriver } from "./cua-driver";
import type { ComputerDriver } from "./driver";
import { checkDriverPin, computerUseSupported, UNSUPPORTED_PLATFORM_MESSAGE } from "./driver-pin";
import { computerDirectory, readComputerState, type ComputerState } from "./grants";
import { ComputerSession } from "./session";

/** Deepest process ancestry followed when finding the terminal Jazz runs in. */
const MAX_ANCESTOR_DEPTH = 32;

export const SESSION_STARTED_MESSAGE =
  "Jazz is using your computer (experimental). Stop it with: jazz computer stop";

function parentPid(pid: number): number | undefined {
  try {
    const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const parent = Number.parseInt(result.stdout.toString().trim(), 10);
    return result.exitCode === 0 && Number.isInteger(parent) ? parent : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This process and every process above it. The terminal app Jazz runs in is among them, and
 * a window of any of them is never observed or acted on.
 */
export function processAncestry(pid: number = process.pid): ReadonlySet<number> {
  const chain = new Set<number>([pid]);
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = parentPid(current);
    if (parent === undefined || parent <= 1 || chain.has(parent)) {
      break;
    }
    chain.add(parent);
    current = parent;
  }
  return chain;
}

export interface OpenComputerSessionOptions {
  readonly agentId: string;
  readonly conversationId: string | undefined;
  readonly announce: (message: string) => void;
  readonly openDriver?: (executablePath: string) => Promise<ComputerDriver>;
  readonly isSupported?: () => boolean;
  readonly readState?: () => Promise<ComputerState>;
  readonly now?: () => number;
  readonly environment?: NodeJS.ProcessEnv;
}

export async function openComputerSession(
  options: OpenComputerSessionOptions,
): Promise<ComputerSession> {
  if (!(options.isSupported ?? computerUseSupported)()) {
    throw new Error(UNSUPPORTED_PLATFORM_MESSAGE);
  }
  const state = await (options.readState ?? readComputerState)();
  const pin = await checkDriverPin(state.acknowledgement, options.environment);
  if (!pin.ok) {
    throw new Error(pin.reason);
  }

  const releaseLock = await acquireComputerLock();
  let driver: ComputerDriver | undefined;
  try {
    await clearStopRequest();
    driver = await (options.openDriver ?? ((executablePath) => CuaDriver.open({ executablePath })))(
      pin.executablePath,
    );
    const session = new ComputerSession({
      driver,
      releaseLock,
      agentId: options.agentId,
      conversationId: options.conversationId,
      capturesDirectory: path.join(
        computerDirectory(),
        "captures",
        storageSafeSegment(options.conversationId ?? options.agentId),
      ),
      announce: options.announce,
      ancestorPids: processAncestry(),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.readState === undefined ? {} : { readState: options.readState }),
    });
    await writeSessionInfo({
      pid: process.pid,
      driverPid: driver.pid,
      conversationId: options.conversationId,
      startedAt: session.startedAt,
    });
    options.announce(SESSION_STARTED_MESSAGE);
    return session;
  } catch (error) {
    await driver?.close().catch(() => undefined);
    await releaseLock().catch(() => undefined);
    throw error;
  }
}

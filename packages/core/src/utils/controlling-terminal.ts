/**
 * @fileoverview Writing bytes to the process's controlling terminal (`/dev/tty`), so a terminal
 * escape such as an OSC notification reaches the user even while a fullscreen TUI owns stdout.
 * Plugins get {@link writeControllingTerminal} as `writeTerminalSequence`; terminal desktop
 * notifications use it too.
 */

import { closeSync, openSync, writeSync } from "node:fs";

const CONTROLLING_TERMINAL_PATH = "/dev/tty";

/**
 * Whether this process has a controlling terminal it can write to. A daemon, a launchd or cron
 * job, and a service have none, whatever `TERM_PROGRAM` they inherited.
 */
export function canWriteControllingTerminal(): boolean {
  try {
    closeSync(openSync(CONTROLLING_TERMINAL_PATH, "w"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` to the controlling terminal. Without one, writes to stdout only when stdout is
 * itself a terminal, so an escape sequence never lands in piped or `--json` output. Never throws.
 *
 * @returns Whether the bytes were written to a terminal.
 */
export function writeControllingTerminal(data: string): boolean {
  try {
    const terminal = openSync(CONTROLLING_TERMINAL_PATH, "w");
    try {
      writeSync(terminal, data);
    } finally {
      closeSync(terminal);
    }
    return true;
  } catch {
    if (process.stdout.isTTY !== true) {
      return false;
    }
  }
  try {
    process.stdout.write(data);
    return true;
  } catch {
    return false;
  }
}

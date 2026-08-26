import * as os from "os";

/**
 * Machine facts every agent receives as grounding in its system prompt.
 *
 * This module is the single source of that truth. The prompt builder fills the
 * `Environment:` block from it, and the wizard's home screen renders the same
 * facts so what you see before a chat matches what the agent is told. Adding a
 * field here makes it available to both consumers; the prompt template itself
 * decides which fields an agent actually sees.
 */
export interface SystemInfo {
  /** Long-form local date with UTC offset and IANA timezone. */
  readonly currentDate: string;
  /** Platform, kernel release and architecture, e.g. "darwin 24.6.0 (arm64)". */
  readonly osInfo: string;
  /** CPU model, core count and total RAM. */
  readonly hardware: string;
  /** The user's login shell from `$SHELL`, or "unknown". */
  readonly shell: string;
  readonly hostname: string;
  readonly username: string;
  readonly homeDirectory: string;
  /** Whether the process is attached to a terminal: "yes" or "no". */
  readonly tty: string;
  /** Working directory the process was started from. */
  readonly cwd: string;
}

function formatUtcOffsetLabel(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  if (offsetMinutes === 0) {
    return "UTC";
  }
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Collect the machine facts synchronously. Cheap enough to call per render. */
export function systemInfo(): SystemInfo {
  const now = new Date();
  const calendarDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeZoneId = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const platform = os.platform();
  const release = os.release();
  const machine = os.machine();
  const cpuModel = os.cpus()[0]?.model ?? "unknown CPU";
  const coreCount = os.cpus().length;
  const totalMemoryGb = Math.round(os.totalmem() / 1024 ** 3);

  return {
    currentDate: `${calendarDate} (${formatUtcOffsetLabel(now)}, ${timeZoneId})`,
    osInfo: `${platform} ${release} (${machine})`,
    hardware: `${cpuModel} · ${coreCount} cores · ${totalMemoryGb} GB RAM`,
    shell: process.env["SHELL"] || "unknown",
    hostname: os.hostname(),
    username: os.userInfo().username,
    homeDirectory: os.homedir(),
    tty: process.stdout.isTTY === true ? "yes" : "no",
    cwd: process.cwd(),
  };
}

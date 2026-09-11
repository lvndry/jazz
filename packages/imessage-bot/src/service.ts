/**
 * @fileoverview Installing the bridge as a background service.
 *
 * A bridge you text is only useful while it is running, so the terminal it was
 * started from is the wrong home for it. launchd is the right one, and running
 * there has a second benefit that matters more: macOS attributes Full Disk
 * Access to the *responsible* process, which from a terminal is the terminal —
 * granting it there hands every command ever typed into that window access to
 * every file on the machine. Under launchd the responsible process is this
 * binary, so the grant covers the bridge alone.
 *
 * Everything here is automatable. The grant itself is not: Full Disk Access is
 * the one TCC class Apple exposes no request API for, so no program can raise
 * that prompt — see `openFullDiskAccessSettings`, which goes as far as anything
 * can by opening the pane and copying the path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_LABEL = "com.github.lvndry.jazz.imessage";

export function servicePlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

export function serviceInstalled(): boolean {
  return existsSync(servicePlistPath());
}

/**
 * Is this process already running under launchd?
 *
 * launchd sets `XPC_SERVICE_NAME` for the jobs it starts, and leaves it unset
 * (or as a placeholder) for a process started from a shell. Used to keep the
 * bridge from offering to install a service while running as one.
 */
export function runningUnderLaunchd(env: NodeJS.ProcessEnv = process.env): boolean {
  const name = env["XPC_SERVICE_NAME"];
  return name !== undefined && name.length > 0 && name !== "0";
}

export interface ServiceSpec {
  /** The binary launchd starts — this process's own executable. */
  readonly runtime: string;
  /**
   * Arguments after the binary.
   *
   * `["imessage"]` when the bridge runs inside the Jazz binary, or the path of
   * bridge.ts when it was started with `bun`. Either way the service runs the
   * same command a person would, so there is one way for it to start and one
   * thing to grant Full Disk Access to.
   */
  readonly args: readonly string[];
  readonly workingDirectory: string;
  readonly jazzHome: string;
  /** Environment the service runs with, minus anything launchd sets itself. */
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * launchd's own PATH contains none of the places a Mac installs things, and the
 * agent shells out through `execute_command` — so this is the PATH the agent's
 * commands get, not merely the bridge's.
 */
const SERVICE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Well above launchd's 10s default: a misconfigured bridge exits immediately,
 * and at 10s that is the same error written into the log six times a minute
 * forever.
 */
const THROTTLE_SECONDS = 30;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderServicePlist(spec: ServiceSpec): string {
  const environment = { PATH: SERVICE_PATH, ...spec.environment };
  const environmentEntries = Object.entries(environment)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(spec.runtime)}</string>
${spec.args.map((arg) => `      <string>${escapeXml(arg)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(spec.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_SECONDS}</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(join(spec.jazzHome, "bridge.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(spec.jazzHome, "bridge.log"))}</string>
  </dict>
</plist>
`;
}

/**
 * The bridge's own settings, to carry into the service.
 *
 * Only what this bridge reads, and never a provider API key: those live in the
 * OS keyring, which the agent reaches on its own. Copying one into a plist
 * would put a credential in a file that is not built to hold one.
 */
const CARRIED_ENV = [
  "IMESSAGE_ALLOWED_HANDLES",
  "IMESSAGE_ALLOWED_GROUP_CHAT_IDS",
  "IMESSAGE_SELF_TRIGGER",
  "IMSG_BIN",
  "JAZZ_BIN",
  "JAZZ_HOME",
  "JAZZ_IMESSAGE_AGENT",
  "JAZZ_IMESSAGE_PROVIDER",
  "JAZZ_IMESSAGE_MODEL",
  "JAZZ_REASONING",
  "JAZZ_APPROVAL_POLICY",
  "JAZZ_AUTO_APPROVE_TOOLS",
  "JAZZ_RUN_TIMEOUT_MS",
  "JAZZ_DAILY_COST_CAP_USD",
  "JAZZ_IMESSAGE_SHOW_REASONING",
] as const;

export function carriedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Readonly<Partial<Record<(typeof CARRIED_ENV)[number], string | undefined>>> = {},
): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const key of CARRIED_ENV) {
    const value = overrides[key] ?? env[key];
    if (value !== undefined && value.length > 0) carried[key] = value;
  }
  return carried;
}

/** Write the plist. Returns its path; never overwrites an existing one. */
export function writeServicePlist(spec: ServiceSpec): string {
  const path = servicePlistPath();
  if (existsSync(path)) {
    throw new Error(`${path} already exists. Remove it first, or edit it by hand.`);
  }
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  // It holds the allow-list and the paths of everything the agent can run.
  writeFileSync(path, renderServicePlist(spec), { mode: 0o600 });
  return path;
}

/** Hand the service to launchd, so it starts now and at every login. */
export async function bootstrapService(): Promise<boolean> {
  const child = Bun.spawn(
    ["launchctl", "bootstrap", `gui/${String(process.getuid?.() ?? 0)}`, servicePlistPath()],
    { stdout: "inherit", stderr: "inherit" },
  );
  return (await child.exited) === 0;
}

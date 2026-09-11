/**
 * @fileoverview `jazz imessage` — reach your agent from Messages.
 *
 * The first run of this command is where setup happens, and nowhere earlier.
 * Installing Jazz does not ask about iMessage: most people never want it, and a
 * request for Full Disk Access from something nobody asked for is alarming
 * rather than helpful. Running this command *is* the request, so it has earned
 * the right to ask.
 *
 * macOS only, and only where Messages is signed in — so this reports that
 * plainly rather than failing at an unrelated place.
 *
 * `--agent` seeds the bridge from an agent you already have. It is copied into
 * the bridge's own home, so the original keeps its name and stays yours.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the background service writes, matching what the bridge configures. */
function defaultLogPath(): string {
  const home = process.env["JAZZ_HOME"]?.trim() || join(homedir(), ".jazz-imessage");
  return join(home, "bridge.log");
}

function requireMac(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "iMessage only exists on macOS, so this bridge only runs there.\n" +
        "On another machine, reach your agent through Telegram, Discord or WhatsApp instead.",
    );
  }
}

async function launchctl(...args: readonly string[]): Promise<number> {
  const child = Bun.spawn(["launchctl", ...args], { stdout: "inherit", stderr: "inherit" });
  return child.exited;
}

function guiDomain(): string {
  return `gui/${String(process.getuid?.() ?? 0)}`;
}

/**
 * Run the bridge in this terminal.
 *
 * On its first run it walks through what it needs — the `imsg` CLI, Full Disk
 * Access, and then whether to keep running in the background.
 */
export async function imessageCommand(agent?: string): Promise<void> {
  requireMac();
  if (agent !== undefined) await selectSeedAgent(agent);
  const { startBridge } = await import("@jazz/imessage-bot/bridge");
  await startBridge();
}

/**
 * Resolve `--agent` against your agent store.
 *
 * Handed over as JAZZ_IMESSAGE_AGENT so the background service inherits it too
 * — the plist is built from the environment.
 */
async function selectSeedAgent(query: string): Promise<void> {
  const { agentStoreDirectory, listAgents, matchAgent } =
    await import("@jazz/imessage-bot/seed-import");

  const home = agentStoreDirectory();
  const agents = listAgents(home);
  const match = matchAgent(agents, query);
  const list = (found: readonly { id: string; name: string }[]): string =>
    found.map((agent) => `  ${agent.id}  ${agent.name}`).join("\n");

  if (match.kind === "ambiguous") {
    throw new Error(
      `More than one agent is called "${query}". Name it by id instead:\n${list(match.matches)}`,
    );
  }
  if (match.kind === "missing") {
    throw new Error(
      agents.length === 0
        ? `No agents in ${home}. Make one with \`jazz create\`.`
        : `No agent "${query}" in ${home}. There is:\n${list(agents)}`,
    );
  }

  process.env["JAZZ_IMESSAGE_AGENT"] = match.id;
}

export async function imessageStopCommand(): Promise<void> {
  requireMac();
  const { SERVICE_LABEL, serviceInstalled } = await import("@jazz/imessage-bot/service");
  if (!serviceInstalled()) {
    console.log("No background service is installed. Nothing to stop.");
    return;
  }
  const code = await launchctl("bootout", `${guiDomain()}/${SERVICE_LABEL}`);
  console.log(code === 0 ? "Stopped." : "It was not running.");
}

export async function imessageStatusCommand(): Promise<void> {
  requireMac();
  const { SERVICE_LABEL, servicePlistPath, serviceInstalled } =
    await import("@jazz/imessage-bot/service");

  if (!serviceInstalled()) {
    console.log("Not installed as a background service.");
    console.log("Run `jazz imessage` and answer yes when it offers to install one.");
    return;
  }

  console.log(`Service: ${servicePlistPath()}`);
  // `launchctl print` is the only thing that knows whether it is actually
  // loaded; the plist existing says only that it was installed once.
  const code = await launchctl("print", `${guiDomain()}/${SERVICE_LABEL}`);
  if (code !== 0) {
    console.log("\nInstalled but not loaded. Start it with `jazz imessage`.");
  }
}

export function imessageLogsCommand(): void {
  requireMac();
  const path = defaultLogPath();
  if (!existsSync(path)) {
    console.log(`No log yet at ${path}. It appears once the bridge has run.`);
    return;
  }
  console.log(`Following ${path} — Ctrl-C to stop.\n`);
  Bun.spawnSync(["tail", "-f", path], { stdout: "inherit", stderr: "inherit" });
}

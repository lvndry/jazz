/**
 * @fileoverview Photon -> Jazz bridge.
 *
 * The agent answers on its own iMessage line instead of on yours, so there is a
 * real conversation to open rather than a chat with yourself and a trigger
 * word. Photon runs the Apple side; this process holds an outbound connection
 * to it, so there is no public URL, no TLS and no tunnel to arrange.
 *
 * Everything after "a message arrived" belongs to the shared turn runner, same
 * as the other bridges. What is here is the connection, who is allowed to use
 * it, and the mapping from a Spectrum space to a per-chat agent.
 *
 * Configuration is entirely environment variables (see README).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeHandle, parseHandleList } from "@jazz/bot-shared/handles";
import { defaultJazzBinary } from "@jazz/bot-shared/jazz-binary";
import { closePrompt, promptLine } from "@jazz/bot-shared/prompt";
import { startReminderSweep } from "@jazz/bot-shared/reminder-sweep";
import { ensureSeedAgent } from "@jazz/bot-shared/seed-agent";
import { agentStoreDirectory, importSeedAgent } from "@jazz/bot-shared/seed-import";
import type { ChatId } from "@jazz/bot-shared/surface";
import { createTurnRunner } from "@jazz/bot-shared/turn";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { createPhotonSurface } from "./surface";

/** The seed agent the bridge makes for itself when `--agent` names none. */
const DEFAULT_BASE_AGENT_ID = "photon";

/** How many times to re-ask before giving up on an allow-list. */
const ALLOW_LIST_ATTEMPTS = 3;

const STORE_FILES = {
  timezone: "ph-tz.json",
  usage: "ph-usage.json",
  sessions: "ph-sessions.json",
  mode: "ph-mode.json",
} as const;

interface BridgeConfig {
  readonly projectId: string;
  readonly projectSecret: string;
  readonly allowedHandles: ReadonlySet<string>;
  readonly jazzBinary: string;
  readonly jazzHome: string;
  readonly baseAgentId: string;
  readonly builtinPersonasDir: string;
  readonly approvalPolicy: string;
  readonly autoApproveTools: readonly string[];
  readonly runTimeoutMs: number;
  readonly dailyCostCapUsd: number;
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly showReasoning: boolean;
}

/**
 * A Spectrum space id turned into an agent id.
 *
 * Keyed on the space rather than the sender so a group keeps one agent, the
 * same way every other bridge scopes a conversation.
 */
export function agentIdForSpace(spaceId: string): string {
  return `ph_${spaceId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Where an answered allow-list is kept, so the question is asked once. */
export function allowListPath(jazzHome: string): string {
  return join(jazzHome, "photon-allowed.json");
}

/** The saved allow-list, verbatim as it was typed. Empty when there is none. */
export function readSavedAllowList(jazzHome: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(allowListPath(jazzHome), "utf8"));
    const saved = (parsed as { allowedHandles?: unknown }).allowedHandles;
    return typeof saved === "string" ? saved : "";
  } catch {
    return "";
  }
}

export function saveAllowList(jazzHome: string, answer: string): void {
  mkdirSync(jazzHome, { recursive: true });
  // Stored as typed rather than normalised, so the file stays editable by hand.
  writeFileSync(
    allowListPath(jazzHome),
    `${JSON.stringify({ allowedHandles: answer }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Ask whose messages the agent should answer.
 *
 * Only ever called with a terminal attached. Refusing to start is right when
 * nobody is there to be asked, but in front of a person it is a question with
 * an obvious answer, so it gets asked rather than printed as an error.
 */
async function askForAllowList(jazzHome: string): Promise<string> {
  console.error(
    "\nNo one is allowed to write to this agent yet.\n" +
      "The line Photon assigns can be texted by anyone who learns it, so the bridge\n" +
      "needs to know whose messages to take. Everyone else is ignored.\n",
  );

  for (let attempt = 0; attempt < ALLOW_LIST_ATTEMPTS; attempt += 1) {
    const answer = await promptLine(
      "Whose messages should it answer? Comma-separated, international form\n(e.g. +15551234567):",
    );
    if (parseHandleList(answer).size > 0) {
      saveAllowList(jazzHome, answer);
      console.error(
        `\nSaved to ${allowListPath(jazzHome)}. Edit or delete that file to change it.\n`,
      );
      return answer;
    }
    console.error(
      "That has no handle in it. Write numbers in international form, e.g. +15551234567.",
    );
  }

  throw new Error("No allow-list given, so the bridge will not start.");
}

/** Where answered credentials are kept, so they are asked for once. */
export function credentialsPath(jazzHome: string): string {
  return join(jazzHome, "photon-credentials.json");
}

export interface PhotonCredentials {
  readonly projectId: string;
  readonly projectSecret: string;
}

export function readSavedCredentials(jazzHome: string): PhotonCredentials | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialsPath(jazzHome), "utf8"));
    const { projectId, projectSecret } = parsed as Partial<PhotonCredentials>;
    if (typeof projectId !== "string" || typeof projectSecret !== "string") return undefined;
    if (projectId.length === 0 || projectSecret.length === 0) return undefined;
    return { projectId, projectSecret };
  } catch {
    return undefined;
  }
}

export function saveCredentials(jazzHome: string, credentials: PhotonCredentials): void {
  mkdirSync(jazzHome, { recursive: true });
  // 0600: the secret can send as your line, so it is no more readable than an
  // API key in the Jazz config.
  writeFileSync(credentialsPath(jazzHome), `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
}

/** Ask for the project credentials, once, and remember them. */
async function askForCredentials(jazzHome: string): Promise<PhotonCredentials> {
  console.error(
    "\nThis bridge needs a Photon project.\n" +
      "Create one at https://app.photon.codes and open its Settings page.\n",
  );

  const projectId = await promptLine("Project ID:");
  const projectSecret = await promptLine("Project secret:");
  if (projectId.trim().length === 0 || projectSecret.trim().length === 0) {
    throw new Error("Both a project id and secret are needed, so the bridge will not start.");
  }

  const credentials = { projectId: projectId.trim(), projectSecret: projectSecret.trim() };
  saveCredentials(jazzHome, credentials);
  console.error(`\nSaved to ${credentialsPath(jazzHome)}. Delete that file to change them.\n`);
  return credentials;
}

async function loadConfig(interactive: boolean): Promise<BridgeConfig> {
  const jazzHome = process.env["JAZZ_HOME"]?.trim() || join(homedir(), ".jazz-photon");

  // The environment wins, then whatever a previous run was told, then a person.
  const fromEnv = {
    projectId: process.env["PHOTON_PROJECT_ID"]?.trim() ?? "",
    projectSecret: process.env["PHOTON_PROJECT_SECRET"]?.trim() ?? "",
  };
  let credentials: PhotonCredentials | undefined =
    fromEnv.projectId.length > 0 && fromEnv.projectSecret.length > 0 ? fromEnv : undefined;
  credentials ??= readSavedCredentials(jazzHome);
  if (credentials === undefined) {
    if (!interactive) {
      throw new Error(
        "PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET are unset, and there is no terminal to " +
          "ask. Create a project at https://app.photon.codes, or run `jazz photon` once from " +
          "a terminal to be asked for them.",
      );
    }
    credentials = await askForCredentials(jazzHome);
  }

  // The environment wins, then whatever a previous run was told, then a person.
  let allowed = parseHandleList(process.env["PHOTON_ALLOWED_HANDLES"]?.trim() ?? "");
  if (allowed.size === 0) allowed = parseHandleList(readSavedAllowList(jazzHome));
  if (allowed.size === 0) {
    if (!interactive) {
      throw new Error(
        "PHOTON_ALLOWED_HANDLES is empty, and there is no terminal to ask. This bridge " +
          "answers on a line anyone can text, so it will not start without an allow-list. " +
          "Set it to a comma-separated list of numbers in international form, or run " +
          "`jazz photon` once from a terminal.",
      );
    }
    allowed = parseHandleList(await askForAllowList(jazzHome));
  }

  return {
    projectId: credentials.projectId,
    projectSecret: credentials.projectSecret,
    allowedHandles: allowed,
    jazzBinary: process.env["JAZZ_BIN"]?.trim() || defaultJazzBinary(),
    jazzHome,
    baseAgentId: process.env["JAZZ_PHOTON_AGENT"]?.trim() || DEFAULT_BASE_AGENT_ID,
    builtinPersonasDir: process.env["JAZZ_BUILTIN_PERSONAS_DIR"]?.trim() || "",
    approvalPolicy: process.env["JAZZ_APPROVAL_POLICY"]?.trim() || "low-risk",
    autoApproveTools: (process.env["JAZZ_AUTO_APPROVE_TOOLS"]?.trim() || "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
    runTimeoutMs: Number.parseInt(process.env["JAZZ_RUN_TIMEOUT_MS"]?.trim() || "300000", 10),
    dailyCostCapUsd: Number.parseFloat(process.env["JAZZ_DAILY_COST_CAP_USD"]?.trim() || "0") || 0,
    provider: process.env["JAZZ_PHOTON_PROVIDER"]?.trim() || "openai",
    model: process.env["JAZZ_PHOTON_MODEL"]?.trim() || "gpt-5.4",
    reasoningEffort: process.env["JAZZ_REASONING"]?.trim() || "medium",
    showReasoning: !["0", "false", "off", "no"].includes(
      process.env["JAZZ_PHOTON_SHOW_REASONING"]?.trim().toLowerCase() ?? "",
    ),
  };
}

/**
 * The number to text to reach the agent, straight from Photon's management API.
 *
 * Worth one request at startup because there is otherwise no way to find it: on
 * a shared plan the line is assigned per registered user, so it is a property
 * of whoever is allowed to write rather than of the project. Without it the
 * bridge sits there connected and you have nothing to text.
 *
 * Best-effort - a management API that is down should not stop a bridge whose
 * message stream is fine.
 */
async function describeLines(config: BridgeConfig): Promise<string> {
  interface PhotonUser {
    readonly phoneNumber?: string;
    readonly assignedPhoneNumber?: string;
  }

  try {
    const auth = Buffer.from(`${config.projectId}:${config.projectSecret}`).toString("base64");
    const response = await fetch(
      `https://spectrum.photon.codes/projects/${config.projectId}/users/`,
      { headers: { authorization: `Basic ${auth}` } },
    );
    if (!response.ok) throw new Error(String(response.status));

    const body = (await response.json()) as { data?: { users?: readonly PhotonUser[] } };
    const lines = (body.data?.users ?? [])
      .filter((user) => user.assignedPhoneNumber !== undefined)
      .map((user) =>
        user.phoneNumber === undefined
          ? `text ${String(user.assignedPhoneNumber)}`
          : `${user.phoneNumber} texts ${String(user.assignedPhoneNumber)}`,
      );

    if (lines.length > 0) return `Reach it here: ${lines.join("; ")}.`;
    return (
      "No line assigned yet, so nothing can reach this agent.\n" +
      "Register the number you will text from at https://app.photon.codes and Photon\n" +
      "assigns the line to text it on."
    );
  } catch {
    return "Could not read the project's assigned lines; carrying on.";
  }
}

export async function startBridge(): Promise<void> {
  const config = await loadConfig(process.stdin.isTTY === true);
  closePrompt();

  // `--agent` arrives as JAZZ_PHOTON_AGENT, so a restart keeps the same seed.
  if (config.baseAgentId !== DEFAULT_BASE_AGENT_ID) {
    const userHome = agentStoreDirectory();
    if (importSeedAgent(userHome, config.jazzHome, config.baseAgentId)) {
      console.error(`Seeded ${config.baseAgentId} from ${userHome} - your original is untouched.`);
    }
  }

  if (
    ensureSeedAgent(config.jazzHome, {
      id: config.baseAgentId,
      name: "Jazz",
      description: "Everyday assistant reachable from iMessage.",
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    })
  ) {
    console.error(
      `Created the template agent ${config.baseAgentId} (${config.provider}/${config.model}) ` +
        `in ${config.jazzHome}. Change it per chat with /model, or set JAZZ_PHOTON_MODEL.`,
    );
  }

  // ponytail: one cast at the SDK boundary. spectrum-ts@12.8.0 publishes types
  // that contradict its own documented call - `imessage.config()` is the
  // example in their quickstart, but the signature demands an argument, and
  // `IMessageDefinition` does not satisfy the factory's `AnyPlatformDef`
  // constraint. Drop the cast when upstream's types and docs agree.
  const providers = [(imessage.config as (config?: unknown) => unknown)()];
  const app = await Spectrum({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers,
  } as unknown as Parameters<typeof Spectrum>[0]);

  // A space is only addressable once it has spoken: Photon's shared line
  // cannot open a conversation the other side did not start.
  const spaces = new Map<ChatId, { send(text: string): Promise<unknown> }>();

  const surface = createPhotonSurface({ resolveSpace: (chatId) => spaces.get(chatId) });
  const runner = createTurnRunner({
    surface,
    jazzBinary: config.jazzBinary,
    jazzHome: config.jazzHome,
    baseAgentId: config.baseAgentId,
    builtinPersonasDir: config.builtinPersonasDir,
    approvalPolicy: config.approvalPolicy,
    autoApproveTools: config.autoApproveTools,
    runTimeoutMs: config.runTimeoutMs,
    dailyCostCapUsd: config.dailyCostCapUsd,
    showReasoning: config.showReasoning,
    files: STORE_FILES,
    agentIdFor: (chatId) => agentIdForSpace(chatId),
  });

  startReminderSweep({
    dataDir: config.jazzHome,
    decodeScope: (agentId) =>
      agentId.startsWith("ph_")
        ? [...spaces.keys()].find((id) => agentIdForSpace(id) === agentId)
        : undefined,
    send: (chatId, body) => runner.send(chatId, body),
  });

  console.error(
    `Photon bridge ready. ${config.allowedHandles.size} allowed handle(s). ` +
      `${await describeLines(config)}`,
  );

  for await (const [space, message] of app.messages) {
    if (message.direction !== "inbound") continue;
    if (message.content.type !== "text") continue;

    // The sender id is the handle Photon delivers on: the only field the SDK
    // types guarantee. The provider's space carries a phone and a dm/group
    // flag too, but only behind an index signature typed for actions, so
    // reading them would be an unchecked cast.
    //
    // ponytail: DM-only allow-list, no group rule. Every other bridge refuses
    // to speak in a group just because a member is allowed; here that needs
    // the space's `type`, which wants a live account to confirm. Add the group
    // check once one is available.
    const sender = message.sender?.id;
    if (sender === undefined || !config.allowedHandles.has(normalizeHandle(sender))) {
      // Never answered: a reply would tell a stranger something automated reads
      // this line.
      console.error(`Ignored a message from ${sender ?? "an unknown sender"}.`);
      continue;
    }

    const chatId: ChatId = space.id;
    spaces.set(chatId, space);
    void runner
      .handle(chatId, message.content.text)
      .catch((error: unknown) => console.error(`Failed to handle ${message.id}: ${String(error)}`));
  }
}

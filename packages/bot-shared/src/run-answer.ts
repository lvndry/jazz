/**
 * @fileoverview Answering a parked unattended run from chat: `/approve <runId>` and
 * `/deny <runId> [why]`, sent by the bridge's operator in reply to a notify-channel message.
 *
 * The answer goes through the local CLI path, `jazz runs approve|reject`, run as the bridge's
 * own process (never inside a conversation's sandbox) against `JAZZ_APPROVALS_HOME`, the Jazz
 * home whose parked runs this bridge answers. Three things keep it the operator's decision:
 * - only senders listed in the bridge's operator setting (`TELEGRAM_OPERATOR_IDS`,
 *   `DISCORD_OPERATOR_IDS`) are heard; with none listed, nobody is;
 * - the bridge only acts on messages the chat platform says a person sent, and an agent run
 *   has no way to send the bridge a message as someone else;
 * - `jazz runs approve` itself refuses when it was started by an agent's tool.
 *
 * With `JAZZ_APPROVALS_HOME` unset the commands answer that approving from chat is off.
 */

import { AGENT_PROCESS_ENV } from "@jazz/core/utils/env";

/** The Jazz home whose parked runs `/approve` answers. Unset turns the commands off. */
export const APPROVALS_HOME_ENV = "JAZZ_APPROVALS_HOME";

/** An answered run can take a while to finish; past this the bridge stops waiting for it. */
export const RUN_ANSWER_TIMEOUT_MS = 10 * 60_000;

/** Run ids are UUIDs; this also keeps anything flag-shaped out of the command line. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Longest excerpt of the finished run's answer echoed back into the chat. */
const ANSWER_EXCERPT_CHARS = 1_500;

export type RunAnswerCommand = "approve" | "deny";

export function isRunAnswerCommand(command: string): command is RunAnswerCommand {
  return command === "approve" || command === "deny";
}

/** Parse the operator id list a bridge reads from its environment (comma or space separated). */
export function parseOperatorIds(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

export interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export type SpawnJazz = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<SpawnResult>;

export interface RunAnswerRequest {
  readonly command: RunAnswerCommand;
  readonly args: string;
  /** The platform's id for whoever sent the message. */
  readonly senderId: string | undefined;
  readonly operatorIds: ReadonlySet<string>;
  /** The environment variable an operator adds their id to, for the refusal message. */
  readonly operatorSettingName: string;
  readonly jazzBinary: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly spawn?: SpawnJazz;
  /** Told once the request is accepted, before the (possibly long) answered run finishes. */
  readonly onAccepted?: (runId: string) => Promise<unknown>;
}

const defaultSpawn: SpawnJazz = async (argv, env, timeoutMs) => {
  const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const stdout = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
};

/** The environment the operator's `jazz runs` command runs in: theirs, pointed at the home. */
function operatorEnv(env: NodeJS.ProcessEnv, approvalsHome: string): NodeJS.ProcessEnv {
  const operator: NodeJS.ProcessEnv = { ...env, JAZZ_HOME: approvalsHome };
  delete operator[AGENT_PROCESS_ENV];
  return operator;
}

function parseEnvelope(stdout: string): { ok?: boolean; error?: string; answer?: string } {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as { ok?: boolean; error?: string; answer?: string };
  } catch {
    return {};
  }
}

/**
 * Handle `/approve <runId>` or `/deny <runId> [why]` and return the reply to send. Never throws:
 * every refusal and failure is a reply.
 */
export async function answerRunFromChat(request: RunAnswerRequest): Promise<string> {
  const env = request.env ?? process.env;
  if (request.senderId === undefined || !request.operatorIds.has(request.senderId)) {
    return `Only this bot's operator can answer a parked run. Your id is ${request.senderId ?? "unknown"}; the operator adds it to ${request.operatorSettingName}.`;
  }
  const approvalsHome = env[APPROVALS_HOME_ENV]?.trim();
  if (approvalsHome === undefined || approvalsHome.length === 0) {
    return `Approving from chat is off on this bridge: set ${APPROVALS_HOME_ENV} to the Jazz home whose parked runs it answers.`;
  }
  const [runId, ...rest] = request.args.trim().split(/\s+/);
  if (runId === undefined || !RUN_ID_PATTERN.test(runId)) {
    return `Usage: /${request.command} <runId>${request.command === "deny" ? " [why]" : ""}. The run id is in the notification.`;
  }
  const note = rest.join(" ").trim();
  const argv =
    request.command === "approve"
      ? [request.jazzBinary, "runs", "approve", runId, "--json"]
      : [
          request.jazzBinary,
          "runs",
          "reject",
          runId,
          "--json",
          ...(note.length > 0 ? ["--note", note] : []),
        ];
  await request.onAccepted?.(runId).catch(() => undefined);
  const spawn = request.spawn ?? defaultSpawn;
  const result = await spawn(argv, operatorEnv(env, approvalsHome), RUN_ANSWER_TIMEOUT_MS).catch(
    (error: unknown) => ({ exitCode: null, stdout: "", error }),
  );
  const envelope = parseEnvelope(result.stdout);
  if (envelope.ok === true) {
    const verb = request.command === "approve" ? "Approved" : "Denied";
    const answer = envelope.answer?.trim();
    return answer === undefined || answer.length === 0
      ? `${verb} run ${runId}. It has finished.`
      : `${verb} run ${runId}. It finished with:\n\n${answer.slice(0, ANSWER_EXCERPT_CHARS)}`;
  }
  if (envelope.error !== undefined) {
    return `Run ${runId} was not answered: ${envelope.error}`;
  }
  return result.exitCode === null
    ? `Run ${runId} did not finish within ${RUN_ANSWER_TIMEOUT_MS / 60_000} minutes; check it with \`jazz runs show ${runId}\`.`
    : `Run ${runId} was not answered (jazz exited with ${result.exitCode}).`;
}

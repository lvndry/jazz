/**
 * @fileoverview OSC 7501 "Program Status" reporting, as specified by the
 * [Program Status Protocol](https://superlogical.com/rex/docs/build/program-status).
 *
 * A program writes `ESC ] 7501 ; state=working:app=jazz:msg=<base64> ST` to its
 * terminal and supporting terminals (Ghostty, Rex, …) keep a live per-process
 * record: a tab spinner while `working`, a "needs you" badge while `blocked`,
 * and a persistent `done`/`error` that survives the process exit and the next
 * shell prompt. Terminals that do not know the sequence ignore it, so emission
 * is free for everyone.
 *
 * Jazz is an ideal emitter because its run state machine already knows exactly
 * when it works, what it is blocked on (approval, question, secret, file
 * picker), and when a turn finishes — no screen-scraping heuristics needed.
 *
 * The writer reuses {@link writeControllingTerminal}, so sequences reach the
 * user even while a fullscreen TUI owns stdout. Set `JAZZ_OSC7501=0` to stop
 * emission entirely.
 */

import { encodeTerminalNotification } from "@/core/notify/terminal-notification";
import { resolveTerminalNotificationSetting } from "@/core/notify/terminal-notification";
import { selectTerminalNotificationProtocol } from "@/core/notify/terminal-notification";
import { writeControllingTerminal } from "./controlling-terminal";
/** Terminal state carried by a status report. */
export type ProgramStatusState = "idle" | "working" | "done" | "blocked" | "error" | "clear";

/** Why the program is blocked. Only meaningful with `state=blocked`. */
export type ProgramStatusKind = "permission" | "question" | "auth";

export interface ProgramStatusReport {
  readonly state: ProgramStatusState;
  /** `blocked` detail; omitted for every other state. */
  readonly kind?: ProgramStatusKind;
  /**
   * Human-readable detail, e.g. the approval's command or the question text.
   * Never include secrets. Terminals may shorten it and must not read meaning
   * into it, so keep it one line.
   */
  readonly msg?: string;
  /**
   * Optional record id (`parent/child`, e.g. `subagent/<agentId>`). Records are
   * replaced wholesale by every report that uses the same id, so `app` and
   * `state` are repeated on every emission regardless of id. A value outside the
   * id grammar is omitted entirely, because a malformed id would otherwise be
   * dropped while the record it was meant to address stays untouched.
   */
  readonly id?: string;
  /** Short human-readable label for the record (sub-agent panel title, etc.). */
  readonly title?: string;
}

const APP = "jazz";
/** Hard cap of the spec; nothing longer is ever written. */
const REPORT_MAX_BYTES = 4096;
/** Decoded length the spec allows before a report is discarded whole. */
const MSG_MAX_CHARS = 2048;
const TITLE_MAX_CHARS = 192;
/** Segment grammar from the spec: `id := segment ("/" segment)*`, 32 per segment, 8 deep. */
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const ESC = "\u001b";
const ST = "\u001b\\";

/** `0`, `false`, `off` (any case) disable emission; anything else leaves it on. */
export function programStatusEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["JAZZ_OSC7501"];
  return (
    raw === undefined ||
    (raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off")
  );
}

/** `true` when `id` is a legal record path the terminal will store. */
function isLegalId(id: string): boolean {
  const segments = id.split("/");
  return (
    segments.length >= 1 &&
    segments.length <= 8 &&
    segments.every((segment) => ID_SEGMENT.test(segment)) &&
    id.length <= 128
  );
}

/**
 * Encode a report into a single OSC 7501 byte sequence, ready to write.
 *
 * Applies the spec's hygiene rules: `msg` and `title` are UTF-8 base64 with
 * control characters (C0, DEL, C1) stripped first, `msg` is truncated to 2048
 * and `title` to 192 decoded characters, and the whole report is capped at
 * 4096 bytes — a report that breaks a limit is discarded whole, so the message
 * is dropped before the state.
 */
export function encodeProgramStatus(report: ProgramStatusReport): string {
  let payload = `state=${report.state}:app=${APP}`;
  if (report.state === "blocked" && report.kind !== undefined) {
    payload += `:kind=${report.kind}`;
  }
  if (report.title !== undefined) {
    payload += `:title=${base64(sanitize(report.title).slice(0, TITLE_MAX_CHARS))}`;
  }
  if (report.id !== undefined && isLegalId(report.id)) {
    payload += `:id=${report.id}`;
  }
  if (report.msg !== undefined && report.msg.length > 0) {
    const msg = base64(sanitize(report.msg).slice(0, MSG_MAX_CHARS));
    payload += `:msg=${msg}`;
    if (Buffer.byteLength(payload, "utf8") > REPORT_MAX_BYTES) {
      // Keep state/kind/id/title; a truncated badge is worth a missing one.
      payload = payload.slice(0, payload.lastIndexOf(":msg="));
    }
  }
  return `${ESC}]7501 ; ${payload}${ST}`;
}

/** Strip C0 controls, DEL and C1 so they cannot escape a decoded free-text value. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, "");
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Report a status to the controlling terminal. Never throws and never writes
 * to piped output; returns whether the bytes were actually emitted. Repeated
 * identical reports are skipped — the terminal would replace its own record
 * with an identical one.
 *
 * A fresh `blocked` or `error` also pings the tab via {@link notifyTerminal}:
 * the badge tells you what is waiting, the ping tells you a tab is waiting.
 */
export function reportProgramStatus(
  report: ProgramStatusReport,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!programStatusEnabled(env)) {
    return false;
  }
  const sequence = encodeProgramStatus(report);
  const last = programStatusCache.last;
  if (last === sequence) {
    return false;
  }
  const written = writeControllingTerminal(sequence);
  if (written) {
    programStatusCache.last = sequence;
  }
  if ((report.state === "blocked" || report.state === "error") && written) {
    const title = report.msg === undefined ? `Jazz ${report.state}` : `Jazz: ${report.msg}`;
    notifyTerminal(title, env);
  }
  return written;
}

/** Module-level dedup cache: the last emitted sequence. */
const programStatusCache: { last: string | null } = { last: null };

/** Drop the dedup cache. For tests. */
export function resetProgramStatusCache(): void {
  programStatusCache.last = null;
}

/**
 * Ping the tab (OSC 9 / 777 / 99, via the shared {@link encodeTerminalNotification})
 * when a run needs a person or fails: a flash, a bell, a badge, depending on what
 * the terminal shows. Protocol selection honors the same
 * `JAZZ_NOTIFICATIONS_TERMINAL` setting as the rest of the notify system, and tmux
 * passthrough is handled there too.
 *
 * The same title within {@link NOTIFICATION_DEDUP_MS} is dropped, so a run that
 * parks, resumes and parks again on the same ask doesn't re-ping every cycle.
 */
export function notifyTerminal(title: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // No config file is loaded at this layer, so the on-disk `notifications.terminal`
  // setting is not consulted; the env override and auto-detection are.
  const setting = resolveTerminalNotificationSetting(env, undefined);
  const protocol = selectTerminalNotificationProtocol(env, setting);
  if (protocol === undefined) {
    return false;
  }
  const clean = sanitize(title).slice(0, 128);
  const now = Date.now();
  if (notificationCache.title === clean && now - notificationCache.at < NOTIFICATION_DEDUP_MS) {
    return false;
  }
  const sequence = encodeTerminalNotification({ title: clean, body: "" }, protocol, {
    id: "jazz",
    env,
  });
  const written = writeControllingTerminal(sequence);
  if (written) {
    notificationCache.title = clean;
    notificationCache.at = now;
  }
  return written;
}

const NOTIFICATION_DEDUP_MS = 3000;
const notificationCache: { title: string | null; at: number } = { title: null, at: 0 };

/** Drop the notification dedup cache. For tests. */
export function resetTerminalNotificationCache(): void {
  notificationCache.title = null;
  notificationCache.at = 0;
}

/**
 * Tell the terminal the working directory (OSC 7) — the sequence tmux and
 * iTerm2 read for tab titles and cwd-aware tooling. Fired when a run or a
 * session starts; harmless everywhere else, and skipped when stdout is piped.
 * `JAZZ_OSC_CWD=0` turns it off.
 */
export function reportProgramCwd(
  dir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["JAZZ_OSC_CWD"];
  const enabled =
    raw === undefined ||
    (raw !== "0" && raw.toLowerCase() !== "false" && raw.toLowerCase() !== "off");
  if (!enabled) {
    return false;
  }
  // OSC 7 takes a file URL; a path with spaces is a different directory.
  return writeControllingTerminal(`${ESC}]7;${encodeURI(dir)}${ST}`);
}

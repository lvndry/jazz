/**
 * @fileoverview Desktop notifications sent as a terminal escape sequence: which sequence a
 * terminal understands, chosen from the environment alone, and the exact bytes of each. Pure: no
 * I/O, nothing is read back from the terminal. The adapter writes the bytes to `/dev/tty`.
 *
 * | Detected from                                   | Sequence | Source                                                   |
 * | ----------------------------------------------- | -------- | -------------------------------------------------------- |
 * | kitty: `KITTY_WINDOW_ID`, or `TERM=xterm-kitty` | OSC 99   | https://sw.kovidgoyal.net/kitty/desktop-notifications/   |
 * | Ghostty: `TERM_PROGRAM=ghostty`                 | OSC 777  | https://ghostty.org/docs/config/reference#desktop-notifications |
 * | WezTerm: `TERM_PROGRAM=WezTerm`                 | OSC 777  | https://wezterm.org/escape-sequences.html                |
 * | Warp: `TERM_PROGRAM=WarpTerminal`               | OSC 777  | https://docs.warp.dev/terminal/more-features/notifications/ |
 * | iTerm2: `TERM_PROGRAM=iTerm.app`, `LC_TERMINAL=iTerm2` | OSC 9 | https://iterm2.com/documentation-escape-codes.html      |
 *
 * Every other terminal gets no sequence and the OS notifier is used instead. That includes VTE
 * terminals (GNOME Terminal, Tilix): upstream VTE reads OSC 777 `notify` only as a shell
 * "Command completed" marker and shows nothing
 * (https://gitlab.gnome.org/GNOME/vte/-/blob/master/src/vteseq.cc). Windows Terminal shows OSC 777
 * only behind an opt-in setting, and Apple Terminal documents no notification sequence.
 *
 * Inside tmux each sequence is wrapped in tmux's DCS passthrough, which tmux forwards only with
 * `set -g allow-passthrough on` (https://github.com/tmux/tmux/wiki/FAQ). GNU screen documents no
 * passthrough, so under screen (`STY`) no sequence is used.
 */

import type { TerminalNotificationSetting } from "@/core/types/config";

export type TerminalNotificationProtocol = "osc99" | "osc777" | "osc9";

export const TERMINAL_NOTIFICATION_SETTINGS = [
  "auto",
  "osc99",
  "osc777",
  "osc9",
  "off",
] as const satisfies readonly TerminalNotificationSetting[];

/** Wins over `notifications.terminal`; a value outside the settings is ignored. */
export const TERMINAL_NOTIFICATIONS_ENV_VAR = "JAZZ_NOTIFICATIONS_TERMINAL";

/**
 * kitty accepts at most 2048 bytes per chunk before encoding. A UTF-8 code point is at most 4
 * bytes, so 500 code points always fit one body chunk and 128 one title chunk.
 */
export const MAX_TERMINAL_NOTIFICATION_BODY_CODE_POINTS = 500;
export const MAX_TERMINAL_NOTIFICATION_TITLE_CODE_POINTS = 128;

const ESC = "\u001b";
const BEL = "\u0007";
const OSC = `${ESC}]`;
const STRING_TERMINATOR = `${ESC}\\`;
const TRUNCATION_MARK = "…";
const KITTY_APPLICATION_NAME = "jazz";
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_RUNS = /[\u0000-\u001f\u007f-\u009f]+/g;
const OSC_FIELD_SEPARATOR = /;/g;

export interface TerminalNotification {
  readonly title: string;
  readonly body: string;
}

export interface TerminalNotificationEncoding {
  /** kitty's notification id: letters, digits, `-` and `_` only. */
  readonly id: string;
  readonly env: NodeJS.ProcessEnv;
}

function isSetting(value: string): value is TerminalNotificationSetting {
  return (TERMINAL_NOTIFICATION_SETTINGS as readonly string[]).includes(value);
}

/** The setting in effect: `JAZZ_NOTIFICATIONS_TERMINAL`, then `notifications.terminal`, then `auto`. */
export function resolveTerminalNotificationSetting(
  env: NodeJS.ProcessEnv,
  configured: TerminalNotificationSetting | undefined,
): TerminalNotificationSetting {
  const fromEnv = env[TERMINAL_NOTIFICATIONS_ENV_VAR]?.trim().toLowerCase();
  if (fromEnv !== undefined && isSetting(fromEnv)) {
    return fromEnv;
  }
  return configured ?? "auto";
}

/** The sequence the terminal in `env` shows as a notification, or undefined when none is known. */
export function detectTerminalNotificationProtocol(
  env: NodeJS.ProcessEnv,
): TerminalNotificationProtocol | undefined {
  if ((env["KITTY_WINDOW_ID"] ?? "").length > 0 || env["TERM"] === "xterm-kitty") {
    return "osc99";
  }
  const termProgram = env["TERM_PROGRAM"];
  if (termProgram === "ghostty" || termProgram === "WezTerm" || termProgram === "WarpTerminal") {
    return "osc777";
  }
  if (termProgram === "iTerm.app" || env["LC_TERMINAL"] === "iTerm2") {
    return "osc9";
  }
  return undefined;
}

/**
 * The sequence to send, or undefined to use the OS notifier: `off` and GNU screen never send
 * one, a forced protocol is used as is, and `auto` detects it from the environment.
 */
export function selectTerminalNotificationProtocol(
  env: NodeJS.ProcessEnv,
  setting: TerminalNotificationSetting,
): TerminalNotificationProtocol | undefined {
  if (setting === "off" || (env["STY"] ?? "").length > 0) {
    return undefined;
  }
  if (setting === "auto") {
    return detectTerminalNotificationProtocol(env);
  }
  return setting;
}

function truncateCodePoints(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maxCodePoints) {
    return text;
  }
  return `${codePoints.slice(0, maxCodePoints - 1).join("")}${TRUNCATION_MARK}`;
}

/** Control characters (ESC, BEL, newlines, C1) become one space, so no text can end a sequence. */
export function sanitizeTerminalNotificationText(text: string, maxCodePoints: number): string {
  return truncateCodePoints(text.replace(CONTROL_CHARACTER_RUNS, " ").trim(), maxCodePoints);
}

function boundedTitle(title: string, stripSeparators: boolean): string {
  const text = stripSeparators ? title.replace(OSC_FIELD_SEPARATOR, "") : title;
  return sanitizeTerminalNotificationText(text, MAX_TERMINAL_NOTIFICATION_TITLE_CODE_POINTS);
}

function boundedBody(body: string, stripSeparators: boolean): string {
  const text = stripSeparators ? body.replace(OSC_FIELD_SEPARATOR, "") : body;
  return sanitizeTerminalNotificationText(text, MAX_TERMINAL_NOTIFICATION_BODY_CODE_POINTS);
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * kitty's chunked OSC 99: the title with `d=0` (hold off showing), then the body with `d=1`,
 * both base64 (`e=1`) so any text is safe. A notification without a body is one `d=1` chunk.
 */
export function encodeOsc99(notification: TerminalNotification, id: string): string[] {
  const title = boundedTitle(notification.title, false);
  const body = boundedBody(notification.body, false);
  const application = `f=${base64(KITTY_APPLICATION_NAME)}`;
  if (body.length === 0) {
    return [`${OSC}99;i=${id}:d=1:e=1:${application}:p=title;${base64(title)}${STRING_TERMINATOR}`];
  }
  return [
    `${OSC}99;i=${id}:d=0:e=1:${application}:p=title;${base64(title)}${STRING_TERMINATOR}`,
    `${OSC}99;i=${id}:d=1:e=1:p=body;${base64(body)}${STRING_TERMINATOR}`,
  ];
}

/**
 * `ESC ] 777 ; notify ; <title> ; <body> BEL`. `;` separates the fields, so it is removed from
 * both; BEL is the terminator Warp documents and the other terminals accept.
 */
export function encodeOsc777(notification: TerminalNotification): string {
  const title = boundedTitle(notification.title, true);
  const body = boundedBody(notification.body, true);
  return `${OSC}777;notify;${title};${body}${BEL}`;
}

/**
 * `ESC ] 9 ; <title>: <body> BEL`. `;` is removed, since text starting with a number and `;` is
 * read as a ConEmu `OSC 9` command by terminals that support those.
 */
export function encodeOsc9(notification: TerminalNotification): string {
  const title = boundedTitle(notification.title, true);
  const body = boundedBody(notification.body, true);
  const text = title.length > 0 && body.length > 0 ? `${title}: ${body}` : `${title}${body}`;
  return `${OSC}9;${text}${BEL}`;
}

/** tmux's DCS passthrough: `ESC P tmux; <sequence with every ESC doubled> ESC \`. */
export function wrapForTmux(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, `${ESC}${ESC}`)}${STRING_TERMINATOR}`;
}

/** The bytes to write to the terminal for `notification`, wrapped for tmux when `TMUX` is set. */
export function encodeTerminalNotification(
  notification: TerminalNotification,
  protocol: TerminalNotificationProtocol,
  encoding: TerminalNotificationEncoding,
): string {
  const sequences =
    protocol === "osc99"
      ? encodeOsc99(notification, encoding.id)
      : [protocol === "osc777" ? encodeOsc777(notification) : encodeOsc9(notification)];
  const insideTmux = (encoding.env["TMUX"] ?? "").length > 0;
  return sequences.map((sequence) => (insideTmux ? wrapForTmux(sequence) : sequence)).join("");
}

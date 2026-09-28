/**
 * What an approval card says the call will do, derived from the kind of call
 * rather than from each tool's own prose.
 *
 * Tools write their approval message for every surface at once, so it is long
 * and generic ("This command will be executed on your system. Only approve
 * commands you trust."). The card instead names the consequence in two or three
 * words on its title row, puts the real numbers the tool measured beside the
 * fields, shows a shell command as code and a file change as a diff, and words
 * its two controls with the verb that will happen: `enter send`, `esc don't send`.
 */

import type { ToolRiskLevel } from "@jazz/core/types/tools";
import { sourceLanguageFromPath } from "../fullscreen/syntax-spans";

export type ActionClass =
  "send" | "delete" | "run" | "edit" | "write" | "move" | "copy" | "create" | "act";

export interface ApprovalDiffRow {
  readonly sign: "+" | "-" | " " | "@";
  readonly text: string;
  /** The line's number in the file it belongs to: the new file for `+` and context, the old one for `-`. */
  readonly line?: number;
}

export interface ApprovalDiff {
  readonly rows: readonly ApprovalDiffRow[];
  readonly added: number;
  readonly removed: number;
}

export interface ApprovalCommand {
  readonly text: string;
  readonly language: string;
}

export interface ApprovalIntent {
  readonly kind: ActionClass;
  /** Two or three words for the title row, in the warning hue: `can't be unsent`. */
  readonly headline?: string;
  readonly accept: string;
  readonly reject: string;
  /** The tool's measured effect, labelled for the field column: `removes · 214 files, 1.3 GB`. */
  readonly impact?: { readonly label: string; readonly value: string };
  readonly command?: ApprovalCommand;
  readonly diff?: ApprovalDiff;
  /** Argument keys the card renders some other way (as the command band or the diff), so the field list skips them. */
  readonly consumedKeys: readonly string[];
}

export interface ApprovalIntentInput {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly riskLevel?: ToolRiskLevel;
  readonly impact?: string;
  readonly previewDiff?: string;
}

const SHELL_TOOLS = new Set(["execute_command"]);
const DELETE_TOOLS = new Set(["rm"]);
const EDIT_TOOLS = new Set(["edit_file"]);
const WRITE_TOOLS = new Set(["write_file"]);
const MOVE_TOOLS = new Set(["mv"]);
const COPY_TOOLS = new Set(["cp"]);
const CREATE_TOOLS = new Set(["mkdir"]);

/** Verbs in a tool's name that put words in front of other people, which nothing can take back. */
const SEND_WORDS = new Set([
  "send",
  "reply",
  "post",
  "publish",
  "invite",
  "share",
  "forward",
  "tweet",
  "comment",
  "message",
  "notify",
]);
const DELETE_WORDS = new Set(["delete", "remove", "trash", "destroy", "drop", "purge", "archive"]);
const CREATE_WORDS = new Set(["create", "add", "schedule", "book", "update", "set", "move"]);

/** Shell commands whose first word removes data. The consequence names that plainly. */
const DESTRUCTIVE_COMMAND =
  /(^|[;&|]\s*|\s)(rm|rmdir|shred|truncate|dd|mkfs)\s|git\s+(clean|reset\s+--hard|push\s+.*--force)/;

function nameWords(toolName: string): readonly string[] {
  return toolName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A unified diff as card rows. File headers (`---`, `+++`, `diff --git`) are
 * dropped: the path is already on the card, and repeating it inside the diff
 * is the same long string twice.
 */
export function parseApprovalDiff(diff: string): ApprovalDiff | undefined {
  const rows: ApprovalDiffRow[] = [];
  let added = 0;
  let removed = 0;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (
      raw.startsWith("+++") ||
      raw.startsWith("---") ||
      raw.startsWith("diff ") ||
      raw.startsWith("index ")
    ) {
      continue;
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (rows.length > 0) {
        rows.push({ sign: "@", text: "⋯" });
      }
      continue;
    }
    const sign = raw[0];
    if (sign === "+") {
      rows.push({ sign: "+", text: raw.slice(1), line: newLine });
      newLine += 1;
      added += 1;
    } else if (sign === "-") {
      rows.push({ sign: "-", text: raw.slice(1), line: oldLine });
      oldLine += 1;
      removed += 1;
    } else if (sign === " ") {
      rows.push({ sign: " ", text: raw.slice(1), line: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  if (added === 0 && removed === 0) {
    return undefined;
  }
  return { rows, added, removed };
}

export function actionClass(toolName: string): ActionClass {
  if (SHELL_TOOLS.has(toolName)) return "run";
  if (DELETE_TOOLS.has(toolName)) return "delete";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (MOVE_TOOLS.has(toolName)) return "move";
  if (COPY_TOOLS.has(toolName)) return "copy";
  if (CREATE_TOOLS.has(toolName)) return "create";
  const words = nameWords(toolName);
  if (words.some((word) => SEND_WORDS.has(word))) return "send";
  if (words.some((word) => DELETE_WORDS.has(word))) return "delete";
  if (words.some((word) => CREATE_WORDS.has(word))) return "create";
  return "act";
}

function runHeadline(command: string, riskLevel: ToolRiskLevel | undefined): string {
  if (DESTRUCTIVE_COMMAND.test(command)) return "deletes files";
  if (riskLevel === "read-only") return "only reads";
  if (riskLevel === "low-risk") return "runs on this machine";
  return "changes this machine";
}

export function approvalIntent(input: ApprovalIntentInput): ApprovalIntent {
  const kind = actionClass(input.toolName);
  const diff = input.previewDiff === undefined ? undefined : parseApprovalDiff(input.previewDiff);
  switch (kind) {
    case "send":
      return {
        kind,
        headline: "can't be unsent",
        accept: "send",
        reject: "don't send",
        ...(input.impact === undefined ? {} : { impact: { label: "sends", value: input.impact } }),
        consumedKeys: [],
      };
    case "delete":
      return {
        kind,
        headline: "can't be undone",
        accept: "delete",
        reject: "don't delete",
        ...(input.impact === undefined
          ? {}
          : { impact: { label: "removes", value: input.impact } }),
        consumedKeys: [],
      };
    case "run": {
      const command = stringArg(input.args, "command");
      return {
        kind,
        ...(command === undefined ? {} : { headline: runHeadline(command, input.riskLevel) }),
        accept: "run",
        reject: "don't run",
        ...(command === undefined ? {} : { command: { text: command, language: "sh" } }),
        consumedKeys: command === undefined ? [] : ["command"],
      };
    }
    case "edit":
      return {
        kind,
        headline: "edits a file",
        accept: "apply",
        reject: "discard",
        ...(diff === undefined ? {} : { diff }),
        // The snapshot is a content hash for the tool's own consistency check; it says nothing a person can judge.
        consumedKeys: diff === undefined ? ["snapshot"] : ["edits", "snapshot"],
      };
    case "write": {
      const creates = input.impact?.startsWith("new file") === true;
      return {
        kind,
        headline: creates ? "creates a file" : "replaces a file",
        accept: "write",
        reject: "don't write",
        ...(input.impact === undefined ? {} : { impact: { label: "writes", value: input.impact } }),
        ...(diff === undefined || creates ? {} : { diff }),
        consumedKeys: diff === undefined || creates ? [] : ["content"],
      };
    }
    case "move":
      return {
        kind,
        headline: "moves files",
        accept: "move",
        reject: "don't move",
        ...(input.impact === undefined ? {} : { impact: { label: "moves", value: input.impact } }),
        consumedKeys: [],
      };
    case "copy":
      return {
        kind,
        headline: "copies files",
        accept: "copy",
        reject: "don't copy",
        ...(input.impact === undefined ? {} : { impact: { label: "copies", value: input.impact } }),
        consumedKeys: [],
      };
    case "create":
      return {
        kind,
        ...(input.riskLevel === "high-risk" ? { headline: "changes a real record" } : {}),
        accept: "confirm",
        reject: "cancel",
        ...(input.impact === undefined
          ? {}
          : { impact: { label: "changes", value: input.impact } }),
        consumedKeys: [],
      };
    case "act":
      return {
        kind,
        accept: "accept",
        reject: "reject",
        ...(input.impact === undefined ? {} : { impact: { label: "effect", value: input.impact } }),
        consumedKeys: [],
      };
  }
}

/** The diff's language, from the path argument, so its rows can be coloured as code. */
export function diffLanguage(args: Readonly<Record<string, unknown>>): string {
  const path = stringArg(args, "path") ?? stringArg(args, "file") ?? stringArg(args, "filePath");
  return path === undefined ? "" : (sourceLanguageFromPath(path) ?? "");
}

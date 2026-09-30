/**
 * A settled tool call as a receipt: what ran, with what, what came back, and, when it did not
 * go through, why and what did not happen. The activity reducer and the plain renderer build it
 * from the executor's events; fullscreen, Ink and plain output lay out the same parts, so a
 * denial or a failure states the same facts on every surface.
 */

import { stripAnsiCodes } from "@/cli/utils/string-utils";
import { declinedOutcome, failureOutcome } from "./failure";
import { isRejectedResult, receiptOutcome } from "./receipt-outcome";
import type { GlyphSet } from "../glyphs";
import { formatPreciseDuration } from "../text/format";
import type { RoleSegment, TextRole } from "../text/roles";

/** The first rows of a file mutation's diff, and how many more the expand key reveals. */
export interface ReceiptDiffPreview {
  readonly lines: readonly string[];
  readonly hiddenLines: number;
}

export type ReceiptStatus = "ok" | "failed" | "denied";

export interface ToolReceipt {
  /** The tool's name; empty for an expanded block that stands in for a receipt. */
  readonly app: string;
  /** The outcome phrase (`300 lines`, `12 entries`); empty when the call failed. */
  readonly summary: string;
  readonly status: ReceiptStatus;
  /** Compact argument preview (`README.md 1–300`). */
  readonly args?: string;
  readonly durationMs?: number;
  /** Why a failed call failed, in the executor's words. */
  readonly reason?: string;
  /** What a failed or declined call did not do. */
  readonly notDone?: string;
  /** The command that fixes a failure, such as `/mcp reconnect slack`. */
  readonly remedyKey?: string;
  /** The full result as plain text, behind the expand key. */
  readonly detail?: string;
  /** A short preview of command output, shown inline in the transcript. */
  readonly outputPreview?: string;
  /** The command-risk classifier's verdict, when it decided this call. */
  readonly classifiedRisk?: string;
  /** A write_file / edit_file diff, shown under the receipt line. */
  readonly diffPreview?: ReceiptDiffPreview;
}

export interface ToolReceiptInput {
  readonly toolName: string | undefined;
  readonly argsPreview?: string | undefined;
  readonly success?: boolean | undefined;
  readonly error?: string | undefined;
  /** A one-line summary the executor supplied, which wins over one derived from the result. */
  readonly summary?: string | undefined;
  /** The result as the tool returned it. */
  readonly result: string;
  /** The result as a renderer formats it for reading, kept as the expandable detail. */
  readonly formattedResult?: string | undefined;
  readonly durationMs: number;
  readonly classifiedRisk?: string | undefined;
  readonly diffPreview?: ReceiptDiffPreview | null | undefined;
}

const FALLBACK_FAILURE = "Tool execution failed";
const COMMAND_PREVIEW_CHARS = 100;

function truncateCommandPreview(text: string): string {
  const normalized = stripAnsiCodes(text).replace(/\r\n/g, "\n").trim();
  if (normalized.length <= COMMAND_PREVIEW_CHARS) return normalized;
  return `${normalized.slice(0, COMMAND_PREVIEW_CHARS - 1).trimEnd()}…`;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function commandResultText(result: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    const fallback = stripAnsiCodes(result).replace(/\r\n/g, "\n").trim();
    return fallback.length > 0 ? fallback : undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    const fallback = stripAnsiCodes(result).replace(/\r\n/g, "\n").trim();
    return fallback.length > 0 ? fallback : undefined;
  }
  const record = parsed as Record<string, unknown>;
  const stdout = stringValue(record["stdout"]);
  const stderr = stringValue(record["stderr"]);
  const exitCode = stringValue(record["exitCode"]);
  const failed = exitCode !== "" && exitCode !== "0";

  if (!stdout && !stderr) {
    return failed ? `failed (exit code ${exitCode}), no output` : "no output";
  }

  const lines: string[] = [];
  if (stdout) lines.push(stdout);
  if (stderr) {
    if (stdout) lines.push("");
    lines.push("stderr:");
    lines.push(stderr);
  }
  if (failed) {
    lines.push("");
    lines.push(`failed (exit code ${exitCode})`);
  }
  return lines.join("\n");
}

function commandOutputPreview(result: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    const fallback = truncateCommandPreview(result);
    return fallback.length > 0 ? fallback : undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    const fallback = truncateCommandPreview(result);
    return fallback.length > 0 ? fallback : undefined;
  }
  const record = parsed as Record<string, unknown>;
  const stdout = stringValue(record["stdout"]);
  if (stdout.trim().length > 0) return truncateCommandPreview(stdout.split("\n")[0] ?? stdout);
  const stderr = stringValue(record["stderr"]);
  if (stderr.trim().length > 0) return truncateCommandPreview(stderr.split("\n")[0] ?? stderr);
  const fallback = truncateCommandPreview(result);
  return fallback.length > 0 ? fallback : undefined;
}

/** The receipt for a settled call. Pure: the same event always gives the same receipt. */
export function toolReceipt(input: ToolReceiptInput): ToolReceipt {
  const failed = input.success === false;
  const denied = failed && isRejectedResult(input.result);
  const app = input.toolName ?? "tool";
  const reason = failed ? input.error?.trim() || FALLBACK_FAILURE : undefined;
  const explicit = input.summary?.trim();
  const outcome =
    explicit !== undefined && explicit.length > 0 && !explicit.includes("\n")
      ? explicit
      : receiptOutcome(input.result);
  const commandDetail =
    input.toolName === "execute_command" || input.toolName === "execute_execute_command"
      ? commandResultText(input.result)
      : undefined;
  const detail = stripAnsiCodes(input.formattedResult ?? commandDetail ?? "").trim();
  const failure =
    reason !== undefined && !denied && input.toolName !== undefined
      ? failureOutcome(input.toolName, reason)
      : undefined;
  const diffPreview = failed ? undefined : (input.diffPreview ?? undefined);
  const argsPreview = input.argsPreview?.trim();
  // The diff replaces the content snippet the arguments carry after the path.
  const args =
    diffPreview !== undefined && argsPreview !== undefined
      ? (argsPreview.split("  ")[0] ?? argsPreview)
      : argsPreview;
  const notDone =
    denied && input.toolName !== undefined ? declinedOutcome(input.toolName) : failure?.notDone;
  const outputPreview =
    input.toolName === "execute_command" || input.toolName === "execute_execute_command"
      ? commandOutputPreview(input.result)
      : undefined;

  return {
    app,
    summary: failed ? "" : (outcome ?? ""),
    status: denied ? "denied" : failed ? "failed" : "ok",
    durationMs: input.durationMs,
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    ...(reason !== undefined && !denied ? { reason } : {}),
    ...(notDone === undefined ? {} : { notDone }),
    ...(failure?.remedy === undefined ? {} : { remedyKey: failure.remedy }),
    ...(!failed && detail.length > 0 && detail !== outcome ? { detail } : {}),
    ...(outputPreview !== undefined && outputPreview.length > 0 ? { outputPreview } : {}),
    ...(input.classifiedRisk === undefined ? {} : { classifiedRisk: input.classifiedRisk }),
    ...(diffPreview === undefined ? {} : { diffPreview }),
  };
}

function isStatus(value: unknown): value is ReceiptStatus {
  return value === "ok" || value === "failed" || value === "denied";
}

/** A receipt read back out of an output entry's metadata, or null when it holds none. */
export function receiptFromMeta(candidate: unknown): ToolReceipt | null {
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record["app"] !== "string" || typeof record["summary"] !== "string") {
    return null;
  }
  const text = (key: string): { readonly [field: string]: string } =>
    typeof record[key] === "string" ? { [key]: record[key] } : {};
  return {
    app: record["app"],
    summary: record["summary"],
    status: isStatus(record["status"]) ? record["status"] : "ok",
    ...(typeof record["durationMs"] === "number" ? { durationMs: record["durationMs"] } : {}),
    ...text("args"),
    ...text("reason"),
    ...text("notDone"),
    ...text("remedyKey"),
    ...text("detail"),
    ...text("outputPreview"),
    ...text("classifiedRisk"),
    ...diffPreviewFromMeta(record["diffPreview"]),
  };
}

function diffPreviewFromMeta(candidate: unknown): { readonly diffPreview?: ReceiptDiffPreview } {
  if (candidate === null || typeof candidate !== "object") {
    return {};
  }
  const record = candidate as Record<string, unknown>;
  const lines = record["lines"];
  const hiddenLines = record["hiddenLines"];
  if (
    !Array.isArray(lines) ||
    !lines.every((line) => typeof line === "string") ||
    typeof hiddenLines !== "number"
  ) {
    return {};
  }
  return { diffPreview: { lines: lines, hiddenLines } };
}

/** The key that opens the whole diff behind a receipt's preview. */
export const EXPAND_DIFF_KEY = "ctrl+e";

export interface ReceiptDiffRow {
  readonly text: string;
  readonly role: TextRole;
}

/** A receipt's diff preview as role-tagged rows, ending in the expand hint when rows are hidden. */
export function receiptDiffRows(receipt: ToolReceipt): ReceiptDiffRow[] {
  const preview = receipt.diffPreview;
  if (preview === undefined) {
    return [];
  }
  const rows: ReceiptDiffRow[] = preview.lines.map((line) => ({
    text: line,
    role: line.startsWith("+")
      ? "success"
      : line.startsWith("-")
        ? "error"
        : line.startsWith("@@")
          ? "secondary"
          : "muted",
  }));
  if (preview.hiddenLines > 0) {
    const noun = preview.hiddenLines === 1 ? "line" : "lines";
    rows.push({
      text: `… ${String(preview.hiddenLines)} more ${noun} · ${EXPAND_DIFF_KEY} to expand`,
      role: "muted",
    });
  }
  return rows;
}

/** What each part of a receipt is, so a renderer can treat one differently (highlight the args). */
export type ReceiptPartKind =
  | "app"
  | "args"
  | "outcome"
  | "denied"
  | "reason"
  | "notDone"
  | "remedy"
  | "remedySuffix"
  | "risk"
  | "duration"
  | "separator";

export interface ReceiptPart extends RoleSegment {
  readonly kind: ReceiptPartKind;
}

export interface ReceiptPartsOptions {
  /** Close with the call's duration, for a scrollback that has no expand key to show it later. */
  readonly duration?: boolean;
}

function part(kind: ReceiptPartKind, text: string, role: TextRole): ReceiptPart {
  return { kind, text, role };
}

/**
 * A receipt as role-tagged parts, the words every renderer shares:
 *
 *   read_file  README.md 1–300  lines 1–100 of 173
 *   write_file  notes.md  denied · the file was not changed
 *   slack_post  token expired · nothing was sent · /mcp reconnect slack to fix
 */
export function receiptParts(
  receipt: ToolReceipt,
  glyphs: GlyphSet,
  options: ReceiptPartsOptions = {},
): ReceiptPart[] {
  const bullet = ` ${glyphs.bullet} `;
  const args = receipt.args?.trim().replace(/\s+/g, " ");
  const summary = receipt.summary.trim();
  const parts: ReceiptPart[] = [];
  const appRole: TextRole =
    receipt.status === "denied" ? "warning" : receipt.status === "failed" ? "error" : "muted";

  if (receipt.app.length > 0) {
    parts.push(part("app", receipt.app, appRole));
  }
  if (args !== undefined && args.length > 0) {
    const argsRole: TextRole =
      receipt.status === "failed" ? "error" : receipt.status === "denied" ? "muted" : "secondary";
    parts.push(part("args", `  ${args}`, argsRole));
  }

  if (receipt.status === "ok") {
    if (summary.length > 0) {
      parts.push(part("outcome", `  ${summary}`, "muted"));
    }
  } else if (receipt.status === "denied") {
    parts.push(part("denied", "  denied", "warning"));
    if (receipt.notDone !== undefined) {
      parts.push(part("separator", bullet, "muted"), part("notDone", receipt.notDone, "muted"));
    }
  } else {
    const reason = receipt.reason?.trim();
    if (summary.length > 0 && (reason === undefined || !summaryRestatesReason(summary, reason))) {
      parts.push(part("outcome", `  ${summary}`, "error"));
    }
    if (reason !== undefined && reason.length > 0) {
      parts.push(part("separator", bullet, "muted"), part("reason", reason, "secondary"));
    }
    if (receipt.notDone !== undefined) {
      parts.push(part("separator", bullet, "muted"), part("notDone", receipt.notDone, "secondary"));
    }
    if (receipt.remedyKey !== undefined) {
      parts.push(
        part("separator", bullet, "muted"),
        part("remedy", receipt.remedyKey, "strong"),
        part("remedySuffix", " to fix", "muted"),
      );
    }
  }

  if (receipt.classifiedRisk !== undefined) {
    parts.push(part("separator", bullet, "muted"), part("risk", receipt.classifiedRisk, "muted"));
  }
  if (options.duration === true && receipt.durationMs !== undefined) {
    parts.push(
      part("separator", bullet, "muted"),
      part("duration", formatPreciseDuration(receipt.durationMs), "muted"),
    );
  }
  return parts;
}

/** The receipt's words as plain text, for search, copy and a screen reader. */
export function receiptPlainText(
  receipt: ToolReceipt,
  glyphs: GlyphSet,
  options: ReceiptPartsOptions = {},
): string {
  return receiptParts(receipt, glyphs, options)
    .map((segment) => segment.text)
    .join("");
}

/** The mark a receipt carries in the gutter: settled, declined or failed. */
export function receiptMark(receipt: ToolReceipt, glyphs: GlyphSet): RoleSegment {
  switch (receipt.status) {
    case "denied":
      return { text: glyphs.proposed, role: "warning" };
    case "failed":
      return { text: glyphs.error, role: "error" };
    case "ok":
      return { text: glyphs.success, role: "success" };
  }
}

/** How much of a long failure reason an outcome phrase has to contain to count as restating it. */
const RESTATED_REASON_PREFIX = 48;

/** True when the outcome phrase only repeats the failure reason, so the receipt says it once. */
export function summaryRestatesReason(summary: string, reason: string): boolean {
  const stripped = summary.replace(/…$/u, "").trim();
  if (stripped.length === 0) {
    return false;
  }
  if (stripped === reason) {
    return true;
  }
  const head = reason.slice(0, Math.min(RESTATED_REASON_PREFIX, reason.length));
  return head.length > 0 && stripped.includes(head);
}

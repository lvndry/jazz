/**
 * Proposes and executes whole-file writes. Approval snapshots bind a tool call, canonical path
 * and replacement content to the original bytes, including across parked-run process restarts.
 * Execution checks that binding under the shared file lock before replacing the file atomically.
 */
import * as path from "node:path";
import { Effect, FileSystem } from "effect";
import { z } from "zod";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import { pinWriteTargets } from "@/core/sandbox/pinned-writes";
import { denyWriteOutsideRoots } from "@/core/sandbox/runtime-policy";
import { redactLines, type RedactedLines } from "@/core/secrets/redacted-lines";
import {
  containsRedactionPlaceholder,
  redactedWriteProblem,
  type KnownSecret,
} from "@/core/secrets/redaction";
import type { ToolExecutionContext } from "@/core/types";
import { generateDiff, generateDiffWithMetadata } from "@/core/utils/diff";
import { jazzStateApprovalNotice, jazzStateChangeReason } from "@/core/utils/jazz-state-paths";
import { withLock } from "@/core/utils/storage";
import { diffExceedsPreview, FILE_MUTATION_PREVIEW_LINES } from "@/core/utils/tool-formatter";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "../base-tool";
import { writeFileAtomically } from "./atomic-replace";
import { buildKeyFromContext } from "../context-utils";
import { toolKnownSecrets } from "../tool-secrets";
import { fileSnapshot } from "./file-snapshot";
import {
  decodeFileBytes,
  dominantLineEnding,
  encodeFileText,
  normalizeLineBreaks,
  type DecodedFile,
} from "./line-endings";

/**
 * Write file tool - writes content to a file.
 * Uses defineApprovalTool to create approval + execution pair.
 */

const writeFileParameters = z
  .object({
    path: z.string().min(1).describe("Absolute or relative to the working directory."),
    content: z.string().describe("The complete file; anything omitted is deleted."),
  })
  .strict();

export type WriteFileArgs = z.infer<typeof writeFileParameters>;

type WriteFileDeps = FileSystem.FileSystem | FileSystemContextService;

function lineCount(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

function pluralLines(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "line" : "lines"}`;
}

/** Most secret line numbers listed in a refusal before it summarizes the rest. */
const LISTED_SECRET_LINES = 10;

/**
 * `content` with each line that matches a secret line of the file as the model was shown it,
 * placeholder and all, put back to the real line. A model rewriting a file it read can only copy
 * the placeholder, so a line it kept unchanged is written back unchanged. A redacted view shared
 * by two different secret lines is ambiguous and stays as written.
 */
function restoreKeptSecretLines(
  content: string,
  currentLines: readonly string[],
  { lines: shownLines, secretLineIndexes }: RedactedLines,
): string {
  if (secretLineIndexes.size === 0 || !containsRedactionPlaceholder(content)) {
    return content;
  }
  const realLineByShown = new Map<string, string | null>();
  for (const index of secretLineIndexes) {
    const shown = shownLines[index] ?? "";
    const real = currentLines[index] ?? "";
    const earlier = realLineByShown.get(shown);
    realLineByShown.set(shown, earlier === undefined || earlier === real ? real : null);
  }
  return content
    .split("\n")
    .map((line) => realLineByShown.get(line) ?? line)
    .join("\n");
}

interface PlannedWrite {
  /** What to write: the model's content with the secret lines it kept restored. */
  readonly content: string;
  /** Why the write must not happen, or undefined when it may. */
  readonly problem: string | undefined;
}

/**
 * The content to write to `target`, and whether it may be written: not when it puts a
 * placeholder where one of the file's secrets is, or leaves out or changes a line of the existing
 * file that holds a secret.
 */
function planWrite(
  target: string,
  requested: string,
  current: DecodedFile | undefined,
): Effect.Effect<PlannedWrite> {
  return Effect.gen(function* () {
    const known = yield* toolKnownSecrets();
    const currentContent = current?.text;
    const currentLines = currentContent?.split("\n");
    const shown = currentLines && redactLines(currentLines, known);
    const normalized = normalizeLineBreaks(requested);
    const content =
      currentLines && shown ? restoreKeptSecretLines(normalized, currentLines, shown) : normalized;
    const secretLineIndexes = shown?.secretLineIndexes ?? new Set<number>();
    return {
      content,
      problem: writeProblem(target, content, currentContent, secretLineIndexes, known),
    };
  });
}

function writeProblem(
  target: string,
  content: string,
  currentContent: string | undefined,
  secretLineIndexes: ReadonlySet<number>,
  known: readonly KnownSecret[],
): string | undefined {
  const placeholderProblem = redactedWriteProblem({
    tool: "write_file",
    field: "content",
    text: content,
    currentContent,
    known,
  });
  if (placeholderProblem !== undefined || currentContent === undefined) {
    return placeholderProblem;
  }
  const currentLines = currentContent.split("\n");
  if (secretLineIndexes.size === 0) {
    return undefined;
  }
  const writtenLines = new Set(content.split("\n"));
  const lostLineNumbers = [...secretLineIndexes]
    .filter((index) => !writtenLines.has(currentLines[index] ?? ""))
    .map((index) => index + 1);
  if (lostLineNumbers.length === 0) {
    return undefined;
  }
  const listed = lostLineNumbers.slice(0, LISTED_SECRET_LINES).join(", ");
  const more =
    lostLineNumbers.length > LISTED_SECRET_LINES
      ? ` and ${String(lostLineNumbers.length - LISTED_SECRET_LINES)} more`
      : "";
  const label = lostLineNumbers.length === 1 ? "line" : "lines";
  return `content leaves out or changes ${label} ${listed}${more} of ${target}, holding secret values you were shown redacted; writing it would lose them. Keep those lines exactly as read_file shows them, placeholders included, or use edit_file to change the other lines.`;
}

/** Most approved overwrites remembered at once; the oldest is forgotten first. */
const MAX_PENDING_APPROVALS = 256;

/** Stands for "no file there" in the version an approval was shown. */
const ABSENT_FILE_VERSION = "absent";

/**
 * The file version each pending approval was shown, keyed by the approval's tool call, the target
 * and the requested content. The first proposal of a call fixes its version; a proposal that
 * repeats while the approval waits (a resumed run proposes again) leaves it as it was, so the
 * execution compares against what the approver saw.
 */
const approvedVersions = new Map<string, string>();

function approvalKey(toolCallId: string, canonicalPath: string, requested: string): string {
  return `${toolCallId}\0${fileSnapshot(canonicalPath, requested)}`;
}

/** Records `version` for `key` unless a version is already recorded; true when it recorded. */
function rememberApprovedVersion(key: string, version: string): boolean {
  if (approvedVersions.has(key)) {
    return false;
  }
  approvedVersions.set(key, version);
  while (approvedVersions.size > MAX_PENDING_APPROVALS) {
    const oldest = approvedVersions.keys().next();
    if (oldest.done === true) {
      break;
    }
    approvedVersions.delete(oldest.value);
  }
  return true;
}

function versionOf(canonicalPath: string, current: DecodedFile | undefined): string {
  return current === undefined ? ABSENT_FILE_VERSION : fileSnapshot(canonicalPath, current.content);
}

/** The path a lock and a version are keyed on: the real file when there is one, else `target`. */
function canonicalPathOf(fs: FileSystem.FileSystem, target: string) {
  return fs.realPath(target).pipe(
    Effect.catch(() =>
      fs.realPath(path.dirname(target)).pipe(
        Effect.map((parent) => path.join(parent, path.basename(target))),
        Effect.catch(() => Effect.succeed(target)),
      ),
    ),
  );
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    return false;
  }
  const { reason } = error;
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  if ("_tag" in reason && reason._tag === "NotFound") {
    return true;
  }
  const cause = "cause" in reason ? reason.cause : undefined;
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOTDIR";
}

/**
 * The existing file at `canonicalPath`, or undefined when it confirmably does not exist. A file
 * that exists but cannot be read fails, since its version cannot be checked.
 */
function readExistingFile(fs: FileSystem.FileSystem, canonicalPath: string) {
  return fs.readFile(canonicalPath).pipe(
    Effect.map((bytes): DecodedFile | undefined => decodeFileBytes(bytes)),
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.fail(
            new Error(
              `${canonicalPath} cannot be read (${error instanceof Error ? error.message : String(error)}), so write_file cannot check what it would replace. Make the file readable, or write to a different path.`,
            ),
          ),
    ),
  );
}

/**
 * The text to write for `content`: exactly what was requested for a new file; for a replaced
 * file, its byte-order mark and line ending carry over unless the content brings its own.
 */
function encodeLikeReplaced(
  content: string,
  requested: string,
  replaced: DecodedFile | undefined,
): string {
  if (replaced === undefined) {
    return requested;
  }
  return encodeFileText({
    bom: content.startsWith("﻿") ? "" : replaced.bom,
    lineEnding: requested.includes("\r\n") ? dominantLineEnding(requested) : replaced.lineEnding,
    text: content,
  });
}

function staleWriteResult(target: string) {
  return {
    success: false,
    result: { errorType: "StaleFileError", path: target },
    error: `File changed since this write_file was proposed: ${target}. Read the file again, merge its current content into your complete new content, and call write_file again. Nothing was written.`,
  } as const;
}

function unverifiedApprovalResult(target: string) {
  return {
    success: false,
    result: { errorType: "UnverifiedApprovalError", path: target },
    error: `This write_file has no recorded proposal in this process, so the file it would replace cannot be checked: ${target}. Call write_file again to get a fresh approval. Nothing was written.`,
  } as const;
}

/**
 * Create write file tools (approval + execution pair).
 * Returns both tools that need to be registered.
 */
export function createWriteFileTools(): ApprovalToolPair<WriteFileDeps> {
  const config: ApprovalToolConfig<WriteFileDeps, WriteFileArgs> = {
    name: "write_file",
    disclosure: "public",
    description:
      "Create a UTF-8 file or replace one entirely, creating missing parent directories. To change part of a file, use edit_file. " +
      "Secret values in files you read appear as `[redacted:<name>]`; a line you keep exactly as read_file showed it, placeholder included, is written back with its real value.",
    tags: ["filesystem", "write"],
    parameters: writeFileParameters,
    validate: makeZodValidator(writeFileParameters),

    approvalMessage: (args: WriteFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });
        const denied = yield* denyWriteOutsideRoots(context, [target]);
        if (denied !== undefined) {
          return { skipApproval: true, toolResult: denied };
        }
        const canonicalTarget = yield* canonicalPathOf(fs, target);
        const current = yield* readExistingFile(fs, canonicalTarget);
        const { content, problem } = yield* planWrite(target, args.content, current);
        if (problem !== undefined) {
          return yield* Effect.fail(new Error(problem));
        }

        const originalContent = current?.text ?? "";
        const isNewFile = current === undefined;
        if (context.toolCallId !== undefined) {
          const recorded = rememberApprovedVersion(
            approvalKey(context.toolCallId, canonicalTarget, args.content),
            versionOf(canonicalTarget, current),
          );
          yield* Effect.logDebug(
            `write_file approval: ${target} ${isNewFile ? "new file" : "overwrite"}, version ${recorded ? "recorded" : "kept from the first proposal"}`,
          );
        }

        // This message is shown to whoever approves the write, which is not always a
        // person at a terminal: it also goes into the `jazz run --json` envelope and out
        // to chat bridges like Telegram. Keep it to what is about to happen. Do not append
        // keyboard hints such as "Press Ctrl+O to preview" — most approvers have no
        // keyboard, and the TUI already renders its own hint from `previewDiff` below.
        let message = `About to write ${content.length} characters to file: ${target}`;

        if (!isNewFile && originalContent.length > 0) {
          message += `\n\n⚠️  WARNING: This will overwrite the existing file (${originalContent.split("\n").length} lines).`;
          message += `\n   Consider using edit_file instead if you only need to modify part of the file.`;
        }
        const stateReason = jazzStateChangeReason(target);
        if (stateReason !== undefined) {
          message += `\n\n${jazzStateApprovalNotice(stateReason)}`;
        }

        // Generate full diff for Ctrl+O expansion
        const { diff } = generateDiffWithMetadata(originalContent, content, target, {
          isNewFile,
          maxLines: Number.POSITIVE_INFINITY,
        });

        const newLines = lineCount(content);
        const impact = isNewFile
          ? `new file, ${pluralLines(newLines)}`
          : `replaces ${pluralLines(lineCount(originalContent))} with ${pluralLines(newLines)}`;
        return {
          message,
          ...(context.toolCallId !== undefined
            ? {
                writeSnapshot: {
                  key: approvalKey(context.toolCallId, canonicalTarget, args.content),
                  version:
                    approvedVersions.get(
                      approvalKey(context.toolCallId, canonicalTarget, args.content),
                    ) ?? versionOf(canonicalTarget, current),
                },
              }
            : {}),
          previewDiff: diff,
          impact,
          ...(stateReason !== undefined ? { alwaysAsk: true as const } : {}),
        };
      }),

    handler: (args: WriteFileArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const shell = yield* FileSystemContextServiceTag;
        const target = yield* shell.resolvePath(buildKeyFromContext(context), args.path, {
          skipExistenceCheck: true,
        });
        const pin = yield* pinWriteTargets(context, [target], { follow: true });
        if (pin.denied !== undefined) {
          return pin.denied;
        }
        const pinnedTarget = pin.paths[0] ?? target;
        const parentDir = pinnedTarget.substring(0, pinnedTarget.lastIndexOf("/"));
        if (parentDir && parentDir !== pinnedTarget) {
          const parentExists = yield* fs
            .exists(parentDir)
            .pipe(Effect.catch(() => Effect.succeed(false)));

          if (!parentExists) {
            const swappedBeforeMkdir = yield* pin.recheck();
            if (swappedBeforeMkdir !== undefined) {
              return swappedBeforeMkdir;
            }
            yield* fs.makeDirectory(parentDir, { recursive: true });
          }
        }
        const canonicalTarget = yield* canonicalPathOf(fs, target);

        // Shares edit_file's lock so the two serialize; the version check, the secret checks and
        // the write all happen inside it.
        return yield* withLock(
          `${canonicalTarget}.jazz-edit.lock`,
          Effect.gen(function* () {
            const current = yield* readExistingFile(fs, canonicalTarget);
            const key =
              context.toolCallId === undefined
                ? undefined
                : approvalKey(context.toolCallId, canonicalTarget, args.content);
            if (key !== undefined) {
              const restored = context.approvedWriteSnapshot;
              const approvedVersion =
                restored !== undefined
                  ? restored.key === key
                    ? restored.version
                    : undefined
                  : context.resumedApproval === true
                    ? undefined
                    : approvedVersions.get(key);
              approvedVersions.delete(key);
              if (approvedVersion === undefined) {
                yield* Effect.logDebug(
                  `write_file execute: ${target} has no recorded proposal, write refused`,
                );
                return unverifiedApprovalResult(target);
              }
              if (approvedVersion !== versionOf(canonicalTarget, current)) {
                yield* Effect.logDebug(
                  `write_file execute: ${target} changed since approval, write refused`,
                );
                return staleWriteResult(target);
              }
            }

            const { content, problem } = yield* planWrite(target, args.content, current);
            if (problem !== undefined) {
              return yield* Effect.fail(new Error(problem));
            }

            const originalContent = current?.text ?? "";
            const isNewFile = current === undefined;

            const swapped = yield* pin.recheck();
            if (swapped !== undefined) {
              return swapped;
            }
            // Old content or new, never a truncated file, however the call is stopped.
            yield* writeFileAtomically(
              fs,
              canonicalTarget,
              encodeLikeReplaced(content, args.content, current),
            );
            yield* Effect.logDebug(
              `write_file execute: ${target} ${isNewFile ? "created" : "overwritten"}, approval ${key === undefined ? "unbound" : "verified"}`,
            );

            const { diff, wasTruncated } = generateDiffWithMetadata(
              originalContent,
              content,
              target,
              { isNewFile },
            );
            const needsExpansion =
              wasTruncated ||
              diffExceedsPreview(diff) ||
              content.split("\n").length > FILE_MUTATION_PREVIEW_LINES;
            const fullDiff = needsExpansion
              ? generateDiff(originalContent, content, target, {
                  isNewFile,
                  maxLines: Number.POSITIVE_INFINITY,
                  fullPatch: true,
                })
              : "";

            return {
              success: true,
              result: {
                path: target,
                message: isNewFile ? `File created: ${target}` : `File written: ${target}`,
                isNewFile,
                diff,
                wasTruncated,
                fullDiff,
              },
            };
          }),
        );
      }),
  };

  return defineApprovalTool<WriteFileDeps, WriteFileArgs>(config);
}

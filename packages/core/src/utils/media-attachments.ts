/**
 * @fileoverview Resolving explicit media paths into message attachments
 *
 * `collectUserInputAttachments` exists for text the *user* typed: it guesses which
 * substrings are paths. Delegation has it easier and stricter — the model names the
 * files it wants a companion to perceive, so every path is explicit, and every one
 * of them must resolve or the call fails loudly rather than silently analyzing less
 * than was asked.
 *
 * Like every attachment path in jazz, the results carry no bytes: path, size, probe.
 * The companion run's own resolver turns them into request data against its model.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  classifyAttachmentPath,
  type AttachmentKind,
  type MessageAttachment,
  rejectAttachmentReason,
} from "@/core/types/attachment";
import { probeMediaShape } from "@/core/utils/media-probe";

export interface MediaResolution {
  /** Attachments that resolved, probed, passed size caps, and match `expectedKind`. */
  readonly attachments: readonly MessageAttachment[];
  /**
   * Problems worth failing over, one per rejected path. Non-empty means the caller
   * should refuse the delegation: a companion asked to look at fewer files than were
   * named would answer confidently about the wrong things.
   */
  readonly errors: readonly string[];
}

/**
 * Resolve `paths` into attachments of exactly `expectedKind`.
 *
 * A missing file, an unsupported extension, or a kind mismatch (an `.mp3` offered to
 * a vision companion) is an error, not a warning — the caller decides what the model
 * sees, and partial perception reads as success downstream.
 */
export async function resolveMediaAttachments(
  paths: readonly string[],
  expectedKind: AttachmentKind,
): Promise<MediaResolution> {
  const attachments: MessageAttachment[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  if (paths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      attachments: [],
      errors: [
        `${paths.length} media files requested but at most ${MAX_ATTACHMENTS_PER_MESSAGE} can be attached per delegation.`,
      ],
    };
  }

  for (const rawPath of paths) {
    const trimmed = rawPath.trim();
    const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);

    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    const classified = classifyAttachmentPath(absolutePath);
    if (classified === null) {
      errors.push(`${absolutePath}: not a supported media file (by extension).`);
      continue;
    }
    if (classified.kind !== expectedKind) {
      errors.push(
        `${absolutePath}: a ${classified.kind} file was given for ${expectedKind} analysis.`,
      );
      continue;
    }

    let byteSize: number;
    try {
      const stats = await stat(absolutePath);
      if (!stats.isFile()) {
        errors.push(`${absolutePath}: not a regular file.`);
        continue;
      }
      byteSize = stats.size;
    } catch {
      errors.push(`${absolutePath}: file not found.`);
      continue;
    }

    const shape = await probeMediaShape(absolutePath, classified.kind);
    const attachment: MessageAttachment = {
      kind: classified.kind,
      mediaType: classified.mediaType,
      path: absolutePath,
      byteSize,
      ...shape,
    };

    // Remote limits apply even when the eventual companion might be local: at propose
    // time the companion is not chosen yet, and rejecting here with a fixable reason
    // beats a picker round-trip followed by a provider 400.
    const rejection = rejectAttachmentReason(attachment, false);
    if (rejection !== null) {
      errors.push(rejection);
      continue;
    }

    attachments.push(attachment);
  }

  return { attachments, errors };
}

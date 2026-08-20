/**
 * @fileoverview Attaching a media file to the current turn from inside a tool
 *
 * Shared by every tool that can be handed a media path. The logic lives here rather than in
 * `read_file` because the decision tree is subtle enough that duplicating it would let the
 * copies drift:
 *
 * 1. Is this even a media file? If not, the caller does its normal text handling.
 * 2. Can the executor carry attachments at all? Some contexts have no message list to extend.
 * 3. Does the active model accept this modality? If not, say so loudly.
 * 4. Is the file within its size limit?
 *
 * Steps 3 and 4 both end in an explicit failure rather than a quiet omission, which is the
 * whole point: a model that asked to see an image and is handed nothing will describe an image
 * it never saw. It has to be told the file exists and did not reach it.
 */

import { stat } from "node:fs/promises";
import {
  classifyAttachmentPath,
  describeAttachment,
  type MessageAttachment,
  rejectAttachmentReason,
} from "@/core/types/attachment";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { probeMediaShape } from "@/core/utils/media-probe";

/**
 * Outcome of trying to attach a path.
 *
 * `not-media` is distinct from a failure so callers can fall through to their normal behaviour
 * — `read_file` on a `.ts` file must not be affected by any of this.
 */
export type AttachMediaOutcome =
  | { readonly kind: "not-media" }
  | { readonly kind: "attached"; readonly result: ToolExecutionResult }
  | { readonly kind: "failed"; readonly result: ToolExecutionResult };

/**
 * Attach `filePath` to the current turn if it is a media file the model can read.
 *
 * On success the tool result is a short text description; the file's actual contents arrive as a
 * file part on the following user message. The description names the path deliberately so the
 * model can re-read it later, after the attachment has aged out of the inline window.
 */
export async function attachMediaFile(
  filePath: string,
  context: ToolExecutionContext | undefined,
): Promise<AttachMediaOutcome> {
  const classified = classifyAttachmentPath(filePath);
  if (classified === null) return { kind: "not-media" };

  if (context?.attachMedia === undefined) {
    return {
      kind: "failed",
      result: {
        success: false,
        result: null,
        error: `${filePath} is a ${classified.kind} file, which cannot be read as text. This run has no way to attach media to the conversation.`,
      },
    };
  }

  const supportedKinds = context.supportedAttachmentKinds ?? [];
  if (!supportedKinds.includes(classified.kind)) {
    // A PDF has a text-extraction path that needs no model capability at all, so pointing at
    // `read_pdf` is far more useful than reporting the modality gap. Only the genuinely
    // unreadable modalities are dead ends.
    const remedy =
      classified.kind === "pdf"
        ? "Use read_pdf instead — it extracts the text without needing native PDF support."
        : `Do not guess what it contains. Report that it could not be read, and suggest switching to a model that accepts ${classified.kind} input.`;
    return {
      kind: "failed",
      result: {
        success: false,
        result: null,
        error: `${filePath} is a ${classified.kind} file and the current model has no ${classified.kind} input, so its contents were not read. ${remedy}`,
      },
    };
  }

  let byteSize: number;
  try {
    byteSize = (await stat(filePath)).size;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "failed",
      result: { success: false, result: null, error: `${filePath} could not be read: ${detail}` },
    };
  }

  const shape = await probeMediaShape(filePath, classified.kind);
  const attachment: MessageAttachment = {
    kind: classified.kind,
    mediaType: classified.mediaType,
    path: filePath,
    byteSize,
    ...shape,
  };

  const rejection = rejectAttachmentReason(attachment);
  if (rejection !== null) {
    return {
      kind: "failed",
      result: { success: false, result: null, error: rejection },
    };
  }

  context.attachMedia(attachment);

  return {
    kind: "attached",
    result: {
      success: true,
      result: {
        attached: true,
        path: filePath,
        kind: attachment.kind,
        description: describeAttachment(attachment),
        note: "The file's contents are attached to this turn and visible in the next message.",
      },
    },
  };
}

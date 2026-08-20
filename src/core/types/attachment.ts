/**
 * @fileoverview Non-text message attachments (image, pdf, audio, video)
 *
 * Jazz carries media alongside a message's text rather than inside it: `ChatMessage.content`
 * stays a string and attachments hang off `ChatMessage.attachments`. That keeps every existing
 * `.content` consumer working untouched, at the cost of requiring code that cares about total
 * context size to look at both (see `TokenCounter.countMessage`).
 *
 * Attachments store a **path**, never bytes. Conversation history is JSON-serialized straight
 * to disk, so inlining base64 would balloon it; bytes are loaded at request time and, for
 * files too large to inline, uploaded to the provider instead.
 */

/**
 * Input modality of an attachment.
 *
 * These mirror the `modalities.input` values models.dev reports, which is what gates whether
 * a given model can accept the attachment at all.
 */
export type AttachmentKind = "image" | "pdf" | "audio" | "video";

/**
 * A non-text file attached to a message.
 *
 * The optional dimension/duration fields exist for token estimation, which is modality
 * specific: image cost scales with pixels, audio and video with time. They are populated
 * best-effort at ingest — when a probe is unavailable the estimator falls back to a
 * conservative constant rather than guessing low.
 */
export interface MessageAttachment {
  readonly kind: AttachmentKind;
  /** Full IANA media type, e.g. "image/png". Passed to the provider as the file part's type. */
  readonly mediaType: string;
  /** Absolute path on disk. This is what gets persisted — never the bytes. */
  readonly path: string;
  /** Byte size at ingest, for cap enforcement and inline-vs-upload routing. */
  readonly byteSize: number;
  /** Pixel dimensions when probed. Image and video token cost is a function of these. */
  readonly width?: number;
  readonly height?: number;
  /** Duration in seconds when probed. Audio and video token cost is time-based. */
  readonly durationSeconds?: number;
  /** Page count when probed. Native-PDF token cost is per-page. */
  readonly pageCount?: number;
}

interface MediaTypeEntry {
  readonly kind: AttachmentKind;
  readonly mediaType: string;
}

/**
 * Extension → modality and media type.
 *
 * Only formats every target provider accepts are listed. Adding a format is one line here;
 * adding a *modality* additionally needs an estimator branch in `estimateAttachmentTokens`
 * and a capability flag in `ModelInfo`.
 */
export const ATTACHMENT_MEDIA_TYPES: Readonly<Record<string, MediaTypeEntry>> = {
  png: { kind: "image", mediaType: "image/png" },
  jpg: { kind: "image", mediaType: "image/jpeg" },
  jpeg: { kind: "image", mediaType: "image/jpeg" },
  webp: { kind: "image", mediaType: "image/webp" },
  gif: { kind: "image", mediaType: "image/gif" },

  pdf: { kind: "pdf", mediaType: "application/pdf" },

  mp3: { kind: "audio", mediaType: "audio/mpeg" },
  wav: { kind: "audio", mediaType: "audio/wav" },
  ogg: { kind: "audio", mediaType: "audio/ogg" },
  oga: { kind: "audio", mediaType: "audio/ogg" },
  m4a: { kind: "audio", mediaType: "audio/mp4" },
  aac: { kind: "audio", mediaType: "audio/aac" },
  flac: { kind: "audio", mediaType: "audio/flac" },

  mp4: { kind: "video", mediaType: "video/mp4" },
  mov: { kind: "video", mediaType: "video/quicktime" },
  webm: { kind: "video", mediaType: "video/webm" },
  mpeg: { kind: "video", mediaType: "video/mpeg" },
};

/**
 * Per-attachment byte ceilings, by modality.
 *
 * Each number is set by the *tightest* limit among the providers that actually accept that
 * modality, so a file accepted here is accepted everywhere jazz can send it. Rejecting locally
 * beats a provider 400 that arrives seconds into a request and reads as a transient failure.
 *
 * - `image` — Anthropic caps a single image at 5MB, the tightest of any vision provider
 *   (OpenAI allows 20MB). Anthropic is jazz's most-used provider, so its limit is the floor.
 * - `pdf` — Anthropic's native-PDF limit is 32MB (and 100 pages, which
 *   `estimateAttachmentTokens` will price out of the context window long before the byte cap
 *   is reached).
 * - `audio` — Gemini is effectively the only provider accepting audio, and inline request data
 *   must fit inside its 20MB total-request cap.
 * - `video` — no provider takes video inline; it always routes through an upload, so this is
 *   just a sanity ceiling on what jazz will read off local disk, not a provider limit.
 */
export const MAX_ATTACHMENT_BYTES: Readonly<Record<AttachmentKind, number>> = {
  image: 5 * 1024 * 1024,
  pdf: 32 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  video: 200 * 1024 * 1024,
};

/**
 * Above this size an attachment is uploaded to the provider and referenced rather than inlined
 * as request bytes.
 *
 * The binding constraint is Gemini's 20MB cap on *total* inline request data — not per file.
 * 6MB leaves room for several attachments plus a long conversation history in the same request
 * without having to reason about their combined size at call time.
 */
export const INLINE_BYTE_LIMIT = 6 * 1024 * 1024;

/**
 * How many recent user turns keep their attachments inlined in a request.
 *
 * History replays on every turn, so an attachment sent once would otherwise be re-sent — and
 * re-billed — for the rest of the conversation. Past this window it degrades to
 * `describeAttachment` text, which still names the path so the model can deliberately re-read
 * the file; `read_file` re-attaches it to the current turn, making the degradation recoverable
 * rather than lossy.
 *
 * Two rather than one because a model often needs the file across the tool round-trip it
 * triggered ("what's in this screenshot?" → grep → answer).
 *
 * Shared between request assembly (`toCoreMessages`) and token estimation (`TokenCounter`).
 * If these two disagree, the estimator either over-counts attachments that are no longer sent
 * — compacting a conversation that had plenty of room — or under-counts ones that are.
 */
export const ATTACHMENT_INLINE_TURN_WINDOW = 2;

/**
 * Indices of the messages whose attachments are still inlined, newest-first by user turn.
 *
 * Counted in *user turns* rather than raw messages so a turn that fanned out twenty tool calls
 * does not age an attachment out in the middle of the investigation that needed it.
 */
export function inlineAttachmentMessageIndices(
  messages: ReadonlyArray<{ readonly role: string }>,
): ReadonlySet<number> {
  const indices = new Set<number>();
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    if (messages[messageIndex]?.role !== "user") continue;
    indices.add(messageIndex);
    if (indices.size >= ATTACHMENT_INLINE_TURN_WINDOW) break;
  }
  return indices;
}

/**
 * Most attachments one message may carry.
 *
 * Exists because ingestion accepts paths from user text: a message mentioning a directory glob
 * should fail cleanly rather than quietly attach forty screenshots and blow the context window.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

function extensionOf(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  const lastSeparator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastDot < lastSeparator) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}

/** The modality an extension maps to, or null when it is not an attachment type. */
export function classifyAttachmentPath(filePath: string): MediaTypeEntry | null {
  return ATTACHMENT_MEDIA_TYPES[extensionOf(filePath)] ?? null;
}

/** Whether this path looks like a supported attachment, by extension alone. */
export function isAttachmentPath(filePath: string): boolean {
  return classifyAttachmentPath(filePath) !== null;
}

/**
 * Why an attachment was rejected, as a message safe to show the model and the user.
 * Returns null when the attachment is acceptable.
 */
export function rejectAttachmentReason(attachment: MessageAttachment): string | null {
  const limit = MAX_ATTACHMENT_BYTES[attachment.kind];
  if (attachment.byteSize > limit) {
    const actualMb = (attachment.byteSize / (1024 * 1024)).toFixed(1);
    const limitMb = (limit / (1024 * 1024)).toFixed(0);
    return `${attachment.path} is ${actualMb} MB, over the ${limitMb} MB limit for ${attachment.kind} attachments`;
  }
  if (attachment.byteSize === 0) {
    return `${attachment.path} is empty`;
  }
  return null;
}

/** Whether this attachment must be uploaded to the provider rather than inlined. */
export function requiresProviderUpload(attachment: MessageAttachment): boolean {
  return attachment.byteSize > INLINE_BYTE_LIMIT;
}

/**
 * Short, human-readable one-liner for an attachment.
 *
 * Used both as the terminal's text stand-in for the file (jazz never renders media inline) and
 * as the placeholder that replaces an attachment when context pressure evicts it, so it has to
 * carry enough for the model to re-read the file deliberately.
 */
export function describeAttachment(attachment: MessageAttachment): string {
  const parts: string[] = [attachment.kind, attachment.path];
  if (attachment.width !== undefined && attachment.height !== undefined) {
    parts.push(`${attachment.width}×${attachment.height}`);
  }
  if (attachment.durationSeconds !== undefined) {
    parts.push(`${attachment.durationSeconds.toFixed(1)}s`);
  }
  if (attachment.pageCount !== undefined) {
    parts.push(`${attachment.pageCount} pages`);
  }
  parts.push(`${(attachment.byteSize / 1024).toFixed(0)} KB`);
  return `[${parts.join(" · ")}]`;
}

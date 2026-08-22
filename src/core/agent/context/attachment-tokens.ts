/**
 * @fileoverview Token cost estimation for message attachments
 *
 * Attachments contribute zero characters to `ChatMessage.content` but 1-2k tokens (images) to
 * tens of thousands (video) of real prompt tokens. Without this, the compaction ladder in
 * `context-thresholds` cannot see them at all: the pre-call estimate would report a comfortable
 * 40% while the actual request overflows the window. Calibration against
 * `usage.promptTokens` does eventually correct the ratio, but only *after* the request that
 * already failed — so the estimate has to be right up front.
 *
 * The bias is deliberately toward over-estimation. Over-estimating costs one slightly early
 * compaction; under-estimating costs a failed request and a confused agent.
 */

import type { AttachmentKind, MessageAttachment } from "@/core/types/attachment";

/**
 * Anthropic's documented image formula: tokens ≈ (width × height) / 750.
 *
 * Used for every provider, not just Anthropic. OpenAI bills by 512px tiles and Gemini by a
 * flat per-image rate, but both land in the same order of magnitude, and this estimate only has
 * to be good enough to decide *whether to compact* — the authoritative number arrives with the
 * response and calibration takes over from there.
 */
const IMAGE_PIXELS_PER_TOKEN = 750;

/**
 * Ceiling on a single image's estimated cost.
 *
 * Providers downscale oversized images before billing, so cost plateaus instead of growing with
 * the file. Anthropic scales anything over 1568px on its long edge down to that bound, which
 * works out to ≈3.3k tokens for a square image — so that, not the raw pixel count of a 40MP
 * photo, is the real worst case.
 */
const MAX_IMAGE_TOKENS = 3_300;

/**
 * A natively-sent PDF page costs roughly a full-page image plus the text extracted from it,
 * since providers do both. This is why native PDF is gated behind `supportsPdf` and text
 * extraction stays the default: a 40-page PDF sent natively is ~80k tokens, which will not fit
 * alongside a working conversation.
 */
const PDF_TOKENS_PER_PAGE = 2_000;

/** Gemini's documented audio rate: 32 tokens per second, independent of bitrate or channels. */
const AUDIO_TOKENS_PER_SECOND = 32;

/**
 * Gemini samples video at 1 frame/second by default, billing ≈258 tokens per sampled frame and
 * the audio track alongside it. A one-minute clip is therefore ≈17k tokens — an order of
 * magnitude past any other attachment, which is why video is the modality most likely to
 * trigger compaction on its own.
 */
const VIDEO_TOKENS_PER_SECOND = 258 + AUDIO_TOKENS_PER_SECOND;

/**
 * Fallbacks for when a probe found nothing.
 *
 * These sit at the high end of plausible on purpose — see the bias note above. An unprobed
 * video is assumed to be a minute long, which is wrong for a 3-second clip and still safer
 * than assuming the clip is free.
 */
const UNPROBED_FALLBACK: Record<AttachmentKind, number> = {
  image: MAX_IMAGE_TOKENS,
  pdf: PDF_TOKENS_PER_PAGE * 10,
  audio: AUDIO_TOKENS_PER_SECOND * 60,
  video: VIDEO_TOKENS_PER_SECOND * 60,
};

/**
 * Estimated prompt tokens for a single attachment.
 *
 * Dispatches on `kind` because the cost driver genuinely differs per modality: pixels for
 * images, pages for PDFs, seconds for audio and video. Falls back to a conservative constant
 * whenever the driving measurement is missing.
 */
export function estimateAttachmentTokens(attachment: MessageAttachment): number {
  switch (attachment.kind) {
    case "image": {
      if (attachment.width === undefined || attachment.height === undefined) {
        return UNPROBED_FALLBACK.image;
      }
      const pixelTokens = Math.ceil(
        (attachment.width * attachment.height) / IMAGE_PIXELS_PER_TOKEN,
      );
      return Math.min(pixelTokens, MAX_IMAGE_TOKENS);
    }
    case "pdf": {
      if (attachment.pageCount === undefined) return UNPROBED_FALLBACK.pdf;
      return attachment.pageCount * PDF_TOKENS_PER_PAGE;
    }
    case "audio": {
      if (attachment.durationSeconds === undefined) return UNPROBED_FALLBACK.audio;
      return Math.ceil(attachment.durationSeconds * AUDIO_TOKENS_PER_SECOND);
    }
    case "video": {
      if (attachment.durationSeconds === undefined) return UNPROBED_FALLBACK.video;
      return Math.ceil(attachment.durationSeconds * VIDEO_TOKENS_PER_SECOND);
    }
  }
}

/** Estimated prompt tokens for every attachment on a message. */
export function estimateAttachmentsTokens(
  attachments: ReadonlyArray<MessageAttachment> | undefined,
): number {
  if (attachments === undefined || attachments.length === 0) return 0;
  let total = 0;
  for (const attachment of attachments) total += estimateAttachmentTokens(attachment);
  return total;
}

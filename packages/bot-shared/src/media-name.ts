/**
 * @fileoverview Naming an inbound attachment before it is written to disk.
 *
 * Every part of an attachment's name arrives from the sender: the message id is minted by
 * their client, the file name is whatever they typed, the MIME type is what they claimed. A
 * name like `photo./../../../etc/cron.d/job` turns "extension after the last dot" into a path
 * that climbs out of the media directory, so nothing from the sender reaches the path
 * unfiltered.
 */

/** Longest extension kept; anything longer is not one a tool will recognise anyway. */
const MAX_EXTENSION_CHARS = 8;
const EXTENSION_PATTERN = new RegExp(`^[a-z0-9]{1,${MAX_EXTENSION_CHARS}}$`);
const UNSAFE_ID_CHARACTERS = /[^A-Za-z0-9_-]/g;
/** Enough of an id to stay unique within one chat's media directory. */
const MAX_ID_CHARS = 64;
const FALLBACK_EXTENSION = "bin";

function extensionCandidate(value: string | undefined): string | undefined {
  const lowered = value?.trim().toLowerCase();
  return lowered !== undefined && EXTENSION_PATTERN.test(lowered) ? lowered : undefined;
}

/**
 * A file name for an attachment: the message id reduced to safe characters, and an extension
 * from the sender's file name, then the MIME subtype, then `bin`.
 */
export function inboundMediaFileName(
  messageId: string,
  originalName: string | undefined,
  mimeType: string | undefined,
): string {
  const id = messageId.replace(UNSAFE_ID_CHARACTERS, "_").slice(0, MAX_ID_CHARS) || "media";
  const fromName =
    originalName !== undefined && originalName.includes(".")
      ? extensionCandidate(originalName.split(".").at(-1))
      : undefined;
  const fromMime = extensionCandidate(mimeType?.split("/").at(-1)?.split(";").at(0));
  return `${id}.${fromName ?? fromMime ?? FALLBACK_EXTENSION}`;
}

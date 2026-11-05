/**
 * A text file split into what an edit works on and what it must hand back: the text with `\n`
 * line breaks, plus the byte-order mark and line ending to restore when writing.
 */

const BYTE_ORDER_MARK = "﻿";

const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf];

export type LineEnding = "\n" | "\r\n";

export interface FileText {
  readonly bom: string;
  readonly lineEnding: LineEnding;
  /** The content with every `\r\n` as `\n` and no byte-order mark. */
  readonly text: string;
}

/** `\r\n` when it ends more lines than a bare `\n` does, otherwise `\n`. */
function dominantLineEnding(content: string): LineEnding {
  const crlfCount = content.match(/\r\n/g)?.length ?? 0;
  const lfCount = (content.match(/\n/g)?.length ?? 0) - crlfCount;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

export function normalizeLineBreaks(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export interface DecodedFile extends FileText {
  /** The decoded content as `read_file` and its snapshot see it: line endings kept, no byte-order mark. */
  readonly content: string;
}

/** Decode the bytes of a UTF-8 file, noting whether they open with a byte-order mark. */
export function decodeFileBytes(bytes: Uint8Array): DecodedFile {
  const bom =
    bytes.length >= UTF8_BOM_BYTES.length &&
    UTF8_BOM_BYTES.every((byte, index) => bytes[index] === byte)
      ? BYTE_ORDER_MARK
      : "";
  const content = new TextDecoder().decode(bytes);
  return {
    bom,
    lineEnding: dominantLineEnding(content),
    text: normalizeLineBreaks(content),
    content,
  };
}

export function encodeFileText({ bom, lineEnding, text }: FileText): string {
  const body = lineEnding === "\n" ? text : text.replace(/\n/g, lineEnding);
  return `${bom}${body}`;
}

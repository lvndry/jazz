/**
 * @fileoverview Comparing a handle someone typed with one a platform sent.
 *
 * Shared by every surface addressed by phone number or email: the operator
 * writes spaces, dashes or a leading `00`, the platform sends E.164.
 */

/**
 * Reduce a handle to the form both sides are compared in.
 *
 * Phone numbers arrive from `chat.db` in E.164 but get written into a config
 * file by a human, who will use spaces, dashes, parentheses or a leading `00`.
 * Emails arrive in whatever case they were registered in. Punctuation and case
 * are the only differences resolved here — a bare national number cannot be
 * matched against an international one without knowing the country, so it is
 * left alone and simply will not match, which is the safe direction.
 */
export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.includes("@")) return trimmed;

  const digits = trimmed.replace(/[\s()\-.]/g, "");
  // `00` is the international prefix in most of the world and `+` is the same
  // thing; normalising one to the other lets a person write either.
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

export function parseHandleList(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeHandle(entry))
      .filter((entry) => entry.length > 0),
  );
}

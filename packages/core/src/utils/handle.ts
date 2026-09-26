/**
 * @fileoverview Short, typeable handles for records people refer to by name (goals, loops):
 * lowercase words joined by hyphens, like `detach-to-prod`.
 */

export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){0,5}$/;
export const MAX_HANDLE_CHARS = 40;
/** Most hyphen-joined words `HANDLE_PATTERN` allows. */
const MAX_HANDLE_WORDS = 6;

/**
 * `suggested` as a handle: lowercased, accents and punctuation dropped, words joined by hyphens,
 * cut to the pattern's limits. `fallback` when nothing survives, such as no Latin letters.
 * Always matches `HANDLE_PATTERN` when `fallback` does.
 */
export function handleFrom(suggested: string | undefined, fallback: string): string {
  const slug = (suggested ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word.length > 0)
    .slice(0, MAX_HANDLE_WORDS)
    .join("-")
    .slice(0, MAX_HANDLE_CHARS)
    .replace(/-+$/, "");
  return HANDLE_PATTERN.test(slug) ? slug : fallback;
}

/** `handle`, or `handle-2`, `handle-3`, … : the first one not in `taken`. */
export function uniqueHandle(handle: string, taken: ReadonlySet<string>): string {
  if (!taken.has(handle)) {
    return handle;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${handle.slice(0, MAX_HANDLE_CHARS - String(suffix).length - 1)}-${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/** Shortest id prefix accepted in place of a whole id. */
const MIN_ID_PREFIX = 4;

/**
 * The record `handle` names among `records`: the one with that name, or else the only one whose
 * id starts with it, so whatever a listing shows can be typed back. Undefined when none or
 * several match.
 */
export function findByNameOrIdPrefix<Named extends { readonly name?: string }>(
  records: readonly Named[],
  handle: string,
  idOf: (record: Named) => string,
): Named | undefined {
  const named = records.find((record) => record.name === handle);
  if (named !== undefined || handle.length < MIN_ID_PREFIX) {
    return named;
  }
  const matches = records.filter((record) => idOf(record).startsWith(handle));
  return matches.length === 1 ? matches[0] : undefined;
}

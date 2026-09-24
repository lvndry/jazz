/**
 * Checks the user text behind an automatic memory mutation.
 *
 * The runner mints memory sources from real user ingress. A model can cite a
 * source and an exact span, but cannot create either one. Compaction passes the
 * original user messages here instead of trusting its rendered transcript.
 */

import type { ChatMessage, MemorySource } from "@/core/types/message";
import { sha256Hex } from "@/core/utils/hash";
import { slugifyMemorySegment } from "./entry-path";

export interface MemorySourceCitation {
  readonly sourceId: string;
  readonly quote: string;
}

export const MAX_SOURCE_QUOTE_CHARS = 500;

export type MemorySourceQuoteCheck =
  | { readonly ok: true; readonly quote: string; readonly source: MemorySource }
  | { readonly ok: false; readonly reason: "quote_length" | "unknown_source" | "quote_not_found" };

/**
 * Every source the model may quote this run: each earlier user message that carried
 * one, then the current message. Earlier turns keep their tag in history, so they
 * must stay quotable or the tag would ask for a citation the tool then refuses.
 */
export function collectMemorySources(
  history: readonly ChatMessage[],
  current: MemorySource | undefined,
): readonly MemorySource[] {
  const earlier = history.flatMap((message) =>
    message.role === "user" && message.memorySource !== undefined ? [message.memorySource] : [],
  );
  return current === undefined ? earlier : [...earlier, current];
}

/** The tag the model sees on a user message it may quote as a memory source. */
export function formatMemorySourceTag(sourceId: string): string {
  return `[memory source ${sourceId}]`;
}

/** Return the cited span and its source, or why the citation cannot be used. */
export function verifyMemorySourceQuote(
  sources: readonly MemorySource[] | undefined,
  citation: MemorySourceCitation,
): MemorySourceQuoteCheck {
  const quote = citation.quote.trim();
  if (quote.length === 0 || quote.length > MAX_SOURCE_QUOTE_CHARS) {
    return { ok: false, reason: "quote_length" };
  }
  const source = sources?.find((candidate) => candidate.id === citation.sourceId);
  if (source === undefined) {
    return { ok: false, reason: "unknown_source" };
  }
  if (!source.text.includes(quote)) {
    return { ok: false, reason: "quote_not_found" };
  }
  return { ok: true, quote, source };
}

/** Model-facing explanation for a rejected citation, naming the argument to fix. */
export function describeQuoteRejection(
  reason: Extract<MemorySourceQuoteCheck, { ok: false }>["reason"],
  sourceId: string,
): string {
  switch (reason) {
    case "quote_length":
      return `Memory write rejected: source_quote must be 1–${MAX_SOURCE_QUOTE_CHARS} characters.`;
    case "unknown_source":
      return `Memory write rejected: source_ref "${sourceId}" is not a memory source in this conversation. Use the ID from a ${formatMemorySourceTag("<id>")} tag.`;
    case "quote_not_found":
      return `Memory write rejected: source_quote was not found in ${sourceId}. Copy the user's words exactly.`;
  }
}

const STORED_CLAIM_PREFIX = "The user said: ";

/** Save the user's words as a quoted assertion, never model-authored paraphrase. */
export function formatStoredUserClaim(quote: string): string {
  return `${STORED_CLAIM_PREFIX}${JSON.stringify(quote)}\n`;
}

/** The quoted words inside a stored claim, or the content itself for hand-written entries. */
function storedClaimText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith(STORED_CLAIM_PREFIX)) {
    return content;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(STORED_CLAIM_PREFIX.length));
    return typeof parsed === "string" ? parsed : content;
  } catch {
    return content;
  }
}

const SENSITIVE_CLAIM_PATTERN =
  /\b(password|passcode|api key|secret|credit card|social security|ssn|medical|diagnosed|religion|political affiliation|sexual orientation)\b/i;

/** Characters that end a sentence for the purpose of scoping a quote to one. */
const SENTENCE_BOUNDARY_PATTERN = /[.!?\n]/;

/** The sentence of `text` that contains `text[start, end)`, so a quote cannot hide its own context. */
function enclosingSentence(text: string, start: number, end: number): string {
  let sentenceStart = start;
  while (sentenceStart > 0 && !SENTENCE_BOUNDARY_PATTERN.test(text[sentenceStart - 1] ?? "")) {
    sentenceStart -= 1;
  }
  const endsOnBoundary = end > start && SENTENCE_BOUNDARY_PATTERN.test(text[end - 1] ?? "");
  let sentenceEnd = end;
  while (
    !endsOnBoundary &&
    sentenceEnd < text.length &&
    !SENTENCE_BOUNDARY_PATTERN.test(text[sentenceEnd] ?? "")
  ) {
    sentenceEnd += 1;
  }
  return text.slice(sentenceStart, sentenceEnd);
}

function quoteOccurrences(source: MemorySource, quote: string): readonly number[] {
  const occurrences: number[] = [];
  let index = source.text.indexOf(quote);
  while (index !== -1) {
    occurrences.push(index);
    index = source.text.indexOf(quote, index + 1);
  }
  return occurrences;
}

/** Sentences of the source overlapped by some occurrence of the quote. */
function quotedSentences(source: MemorySource, quote: string): readonly string[] {
  const sentences = new Set<string>();
  for (const start of quoteOccurrences(source, quote)) {
    const covered = enclosingSentence(source.text, start, start + quote.length);
    for (const sentence of covered.split(SENTENCE_BOUNDARY_PATTERN)) {
      const trimmed = sentence.trim();
      if (trimmed.length > 0) {
        sentences.add(trimmed);
      }
    }
  }
  return [...sentences];
}

/**
 * Keys naming each sentence a quote came from, for the source ledger. A key is
 * a hash of the source ID and sentence, so the ledger can revoke one fact from a
 * message without storing its words, and a different span of a revoked sentence
 * is still recognized.
 */
export function quotedSentenceKeys(source: MemorySource, quote: string): readonly string[] {
  return quotedSentences(source, quote).map((sentence) =>
    sha256Hex(`${source.id}\u0000${sentence}`),
  );
}

/**
 * Block secrets and sensitive personal claims at either model-facing write path.
 *
 * The model chooses both the quoted span and the subject, so the whole sentence
 * around the quote and every name the entry would be filed under are checked.
 */
export function isSensitiveUserClaim(
  source: MemorySource,
  quote: string,
  filedUnder: readonly string[],
): boolean {
  const sentences = quoteOccurrences(source, quote).map((start) =>
    enclosingSentence(source.text, start, start + quote.length),
  );
  return [quote, ...sentences, ...filedUnder].some((text) => SENSITIVE_CLAIM_PATTERN.test(text));
}

/** Words shorter than this carry no subject ("is", "my", "to"). */
const MIN_SUBJECT_TOKEN_LENGTH = 3;

const NON_SUBJECT_TOKENS = new Set([
  "about",
  "and",
  "entry",
  "from",
  "memory",
  "please",
  "remember",
  "that",
  "the",
  "this",
  "what",
  "with",
  "you",
  "your",
]);

/** Words normalized the way file names are, per word so a long quote is not cut at the slug limit. */
function subjectTokens(text: string): ReadonlySet<string> {
  return new Set(
    text
      .split(/\s+/)
      .flatMap((word) => slugifyMemorySegment(word).split("-"))
      .filter(
        (token) => token.length >= MIN_SUBJECT_TOKEN_LENGTH && !NON_SUBJECT_TOKENS.has(token),
      ),
  );
}

/** What an existing entry is about: its file name and the words stored in it. */
export interface MemoryEntryIdentity {
  readonly path: string;
  readonly content: string;
}

function entrySubjectTokens(entry: MemoryEntryIdentity): ReadonlySet<string> {
  const fileName = entry.path.split("/").at(-1)?.replace(/\.md$/, "") ?? "";
  return new Set([...subjectTokens(fileName), ...subjectTokens(storedClaimText(entry.content))]);
}

/** Whether the quote names what the entry is about, so one sentence cannot retarget any entry. */
export function quoteNamesEntry(quote: string, entry: MemoryEntryIdentity): boolean {
  const entryTokens = entrySubjectTokens(entry);
  return [...subjectTokens(quote)].some((token) => entryTokens.has(token));
}

const CHANGE_VERBS = {
  forget: "forget|delete|erase|remove",
  rename: "rename|move",
} as const;

/** Verbs that only ever address memory; ordinary verbs like "remove" also state preferences. */
const MEMORY_ONLY_VERBS = "forget|erase";

const POLITE_LEAD_IN = "(?:please\\s+|can you\\s+|could you\\s+|i want you to\\s+)?";

function startsWithVerb(text: string, verbs: string): boolean {
  return new RegExp(`^\\s*${POLITE_LEAD_IN}(?:${verbs})\\b`, "i").test(text);
}

/** Whether some occurrence of the quote starts a sentence of the source, not the middle of one. */
function startsSentence(source: MemorySource, quote: string): boolean {
  return quoteOccurrences(source, quote).some((start) => {
    const before = source.text.slice(0, start).trimEnd();
    return before.length === 0 || SENTENCE_BOUNDARY_PATTERN.test(before.at(-1) ?? "");
  });
}

/**
 * Destructive tool actions require a direct user instruction about that entry.
 *
 * The quote must open a sentence with the verb, so "Don't forget I'm vegetarian"
 * cannot be cut down to "forget I'm vegetarian", and it must name the entry, so
 * "remove the old logs" cannot delete a food preference.
 */
export function requestsMemoryChange(
  source: MemorySource,
  quote: string,
  action: keyof typeof CHANGE_VERBS,
  entry: MemoryEntryIdentity,
): boolean {
  return (
    startsWithVerb(quote, CHANGE_VERBS[action]) &&
    startsSentence(source, quote) &&
    quoteNamesEntry(quote, entry)
  );
}

/** Whether a quote offered as a fact is really an instruction to forget something. */
export function isForgetInstruction(source: MemorySource, quote: string): boolean {
  return startsWithVerb(quote, MEMORY_ONLY_VERBS) && startsSentence(source, quote);
}

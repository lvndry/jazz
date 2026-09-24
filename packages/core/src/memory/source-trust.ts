/**
 * Authenticates the user text behind an automatic memory mutation.
 *
 * The runner supplies these sources from real user ingress. A model can cite a
 * source and an exact span, but cannot create either one. Compaction passes the
 * original user messages here instead of trusting its rendered transcript.
 */

export interface AuthenticatedUserSource {
  readonly id: string;
  readonly text: string;
}

export interface UserSourceCitation {
  readonly sourceRef: string;
  readonly sourceQuote: string;
}

const MAX_SOURCE_QUOTE_CHARS = 500;

/** Return an exact authenticated span, or abstain when the citation is invalid. */
export function authenticatedQuote(
  sources: readonly AuthenticatedUserSource[] | undefined,
  citation: UserSourceCitation,
): string | undefined {
  const quote = citation.sourceQuote.trim();
  if (quote.length === 0 || quote.length > MAX_SOURCE_QUOTE_CHARS) return undefined;
  const source = sources?.find((candidate) => candidate.id === citation.sourceRef);
  if (source === undefined || !source.text.includes(quote)) return undefined;
  return quote;
}

/** Save the user's words as a quoted assertion, never model-authored paraphrase. */
export function storedUserClaim(quote: string): string {
  return `The user said: ${JSON.stringify(quote)}\n`;
}

/** Block obvious secrets and sensitive personal claims at either model-facing write path. */
export function isSensitiveUserClaim(quote: string): boolean {
  return /\b(password|passcode|api key|secret|credit card|social security|ssn|medical|diagnosed|religion|political affiliation|sexual orientation)\b/i.test(
    quote,
  );
}

/** Destructive tool actions require a direct user instruction in the cited span. */
export function explicitlyRequestsMemoryChange(
  quote: string,
  action: "forget" | "rename",
): boolean {
  const verb = action === "forget" ? "forget|delete|erase|remove" : "rename|move";
  return new RegExp(`^\\s*(?:please\\s+|can you\\s+|i want you to\\s+)?(?:${verb})\\b`, "i").test(
    quote,
  );
}

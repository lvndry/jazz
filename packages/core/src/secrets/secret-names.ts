/**
 * The one vocabulary for names that hold secrets, and the one placeholder written in place of a
 * secret value. Tool output redaction, log metadata, HTTP headers shown to the model, config
 * display and the child-process environment scrub all decide from here.
 *
 * A name is split into words at `_`, `-`, `.`, spaces and camelCase boundaries, so `apiKey`,
 * `API_KEY`, `x-api-key` and `api.key` read the same. Matching is on whole words, so
 * `KEYBOARD_LAYOUT`, `MONKEY` and `TOKENIZER_PATH` hold no secret word.
 */

export const PLACEHOLDER_PREFIX = "[redacted:";

/** What stands in for a secret value: `[redacted:<name>]`, naming where the value came from. */
export function redactionPlaceholder(name: string): string {
  return `${PLACEHOLDER_PREFIX}${name}]`;
}

/** Whether `text` carries a placeholder written in place of a secret. */
export function containsRedactionPlaceholder(text: string): boolean {
  return text.includes(PLACEHOLDER_PREFIX);
}

/** Words that make a name secret wherever they end it: `DB_PASSWORD`, `clientSecret`, `x-auth-token`. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "APIKEY",
  "AUTHORIZATION",
  "COOKIE",
  "PASS",
  "AUTH",
]);

/**
 * Secret words that also count run into a longer word, as in `GITHUBTOKEN` or `clientsecret`.
 * `KEY`, `PASS` and `AUTH` are left out: `MONKEY`, `BYPASS` and `OAUTH` are ordinary words.
 */
const CONCATENATED_SECRET_WORDS: readonly string[] = [
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "APIKEY",
];

/** Words that end a key-holding name without making it secret: `SORT_KEY`, `publicKey`, `cacheKey`. */
const NON_SECRET_KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  "PUBLIC",
  "PUB",
  "SORT",
  "CACHE",
  "PRIMARY",
  "PARTITION",
  "FOREIGN",
  "ROW",
  "OBJECT",
  "HOT",
  "INDEX",
  "LOOKUP",
  "ROUTING",
  "MAP",
  "GROUP",
  "IDEMPOTENCY",
  "DEDUPE",
  "TRANSLATION",
  "MESSAGE",
  "SHORTCUT",
  "UNIQUE",
  "COMPOSITE",
]);

/**
 * Words after a secret word that still name the secret itself: `SECRET_KEY_BASE`,
 * `TOKEN_VALUE`, `OPENAI_API_KEY_2`. Any other trailing word (`TOKEN_URL`, `PASSWORD_STORE_DIR`)
 * names something about the secret, not the secret.
 */
const VALUE_FORM_SUFFIXES: ReadonlySet<string> = new Set([
  "VALUE",
  "BASE",
  "B64",
  "BASE64",
  "HEX",
  "RAW",
]);

const NUMERIC_WORD = /^\d+$/;

/** `name` as upper-case words: `openaiApiKey` and `OPENAI_API_KEY` both give `OPENAI API KEY`. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toUpperCase());
}

function withoutValueFormSuffixes(words: readonly string[]): string[] {
  const trimmed = [...words];
  while (trimmed.length > 1) {
    const last = trimmed[trimmed.length - 1] ?? "";
    if (!VALUE_FORM_SUFFIXES.has(last) && !NUMERIC_WORD.test(last)) {
      break;
    }
    trimmed.pop();
  }
  return trimmed;
}

function isSecretFinalWord(words: readonly string[]): boolean {
  const last = words[words.length - 1];
  if (last === undefined) {
    return false;
  }
  if (SECRET_WORDS.has(last)) {
    return true;
  }
  if (last === "KEY") {
    const qualifier = words[words.length - 2];
    return qualifier !== undefined && !NON_SECRET_KEY_QUALIFIERS.has(qualifier);
  }
  if (last === "PWD") {
    return words.length > 1;
  }
  return CONCATENATED_SECRET_WORDS.some((word) => last.length > word.length && last.endsWith(word));
}

/**
 * Whether a variable, key or header named `name` holds a secret value: `OPENAI_API_KEY`,
 * `APP_KEY`, `DB_PASS`, `refresh_token`, `x-api-key`, `auth`, `SECRET_KEY_BASE`. The secret word
 * has to end the name, so `TOKEN_URL`, `token_type` and `max_tokens` do not hold one.
 */
export function isSecretName(name: string): boolean {
  return isSecretFinalWord(withoutValueFormSuffixes(nameWords(name)));
}

/**
 * Whether `name` has a secret word anywhere in it: `GITHUB_TOKEN_FILE`, `AUTH_HEADER_JSON`, as
 * well as everything {@link isSecretName} accepts. This is the wider net for the environment
 * handed to a child process, where passing a variable on is what exposes it.
 */
export function mentionsSecret(name: string): boolean {
  if (isSecretName(name)) {
    return true;
  }
  const words = nameWords(name);
  return words.some(
    (word, index) =>
      SECRET_WORDS.has(word) ||
      (word === "KEY" && index > 0 && !NON_SECRET_KEY_QUALIFIERS.has(words[index - 1] ?? "")),
  );
}

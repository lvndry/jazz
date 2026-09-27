/**
 * Secret redaction for text that leaves a tool: what the model, the transcript, the logs and any
 * notification see.
 *
 * Files are read as they are, whoever wrote them. What is withheld is the secret values inside
 * them, in two passes:
 *
 * - Known values: every secret Jazz holds (config secret paths, resolved from the keyring and the
 *   environment) and every secret-named environment variable of this process. An exact match is
 *   replaced wherever it appears, in any file or command output.
 * - Recognizable shapes: provider key formats, private key blocks, `NAME=value` lines whose name
 *   says secret, quoted secret-named literals, bearer credentials and passwords in URLs. This is
 *   what covers `.env`, `.zshrc` and other files holding secrets Jazz never saw.
 *
 * A secret the model transforms before it reaches a tool result (base64 in a shell pipeline, for
 * one) is not recognized by either pass.
 */

import { isSecretPath } from "@/core/secrets/registry";
import { isApprovalRequiredResult, type ToolExecutionResult } from "@/core/types/tools";

export interface KnownSecret {
  /** What the placeholder names: a config path or an environment variable. */
  readonly name: string;
  readonly value: string;
}

/**
 * Shortest value treated as a known secret. Below this, a value such as `true`, a port number or
 * a short word would be replaced everywhere it appears in ordinary text.
 */
const MIN_KNOWN_SECRET_LENGTH = 8;

const PLACEHOLDER_PREFIX = "[redacted:";

/** A key name in JSON, YAML or source that ends in a secret word: `apiKey`, `client_secret`, `authToken`. */
const SECRET_KEY_NAME =
  /(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token|passw(?:or)?d|credentials?|private[_-]?key)$/i;

/** An environment variable name with a secret word as one of its parts: `OPENAI_API_KEY`, `DB_PASSWORD`. */
const SECRET_ENV_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY)(?:_|$)/i;

export function redactionPlaceholder(name: string): string {
  return `${PLACEHOLDER_PREFIX}${name}]`;
}

/** Whether `text` carries a placeholder this module wrote in place of a secret. */
export function containsRedactionPlaceholder(text: string): boolean {
  return text.includes(PLACEHOLDER_PREFIX);
}

/**
 * Why writing `text` as `field` would lose a secret, or undefined when it holds no placeholder.
 * Tool output shows secrets as placeholders, so text copied from it and written back would
 * replace the real value.
 */
export function redactedWriteProblem(field: string, text: string): string | undefined {
  if (!containsRedactionPlaceholder(text)) {
    return undefined;
  }
  return `${field} contains a ${PLACEHOLDER_PREFIX}…] placeholder, which stands for a secret you were not shown. Writing it would replace the real value in the file. Leave the lines that hold secrets out of ${field}.`;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith("./");
}

function collectConfigSecrets(value: unknown, prefix: string, into: KnownSecret[]): void {
  if (typeof value === "string") {
    if (prefix !== "" && isSecretPath(prefix)) {
      into.push({ name: prefix, value });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectConfigSecrets(item, `${prefix}.${String(index)}`, into));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      collectConfigSecrets(nested, prefix === "" ? key : `${prefix}.${key}`, into);
    }
  }
}

/**
 * The secret values to replace exactly: every string at a secret config path of `config` (the
 * resolved config, with keyring and environment values filled in), and every environment variable
 * whose name says secret. Longest first, so a value containing another is replaced whole.
 */
export function collectKnownSecrets(
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
): KnownSecret[] {
  const found: KnownSecret[] = [];
  collectConfigSecrets(config, "", found);
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && SECRET_ENV_NAME.test(name) && !looksLikePath(value)) {
      found.push({ name, value });
    }
  }
  const byValue = new Map<string, KnownSecret>();
  for (const secret of found) {
    const value = secret.value.trim();
    if (value.length >= MIN_KNOWN_SECRET_LENGTH && !byValue.has(value)) {
      byValue.set(value, { name: secret.name, value });
    }
  }
  return [...byValue.values()].sort((left, right) => right.value.length - left.value.length);
}

interface SecretShape {
  readonly pattern: RegExp;
  readonly replace: (...groups: string[]) => string;
}

/** The assignment with its value replaced, or undefined when the value is a reference or a path. */
function redactedAssignment(
  name: string,
  prefix: string,
  value: string,
  suffix = "",
): string | undefined {
  if (
    value === "" ||
    value.startsWith("$") ||
    looksLikePath(value) ||
    containsRedactionPlaceholder(value)
  ) {
    return undefined;
  }
  return `${prefix}${redactionPlaceholder(name)}${suffix}`;
}

const SECRET_SHAPES: readonly SecretShape[] = [
  {
    pattern:
      /-----BEGIN ((?:[A-Z]+ )*PRIVATE KEY)-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
    replace: () => redactionPlaceholder("private-key"),
  },
  {
    // `NAME=value` lines: .env files, shell profiles, `env` output, compose lists, diff lines, and
    // the same lines behind read_file's `N|` or `cat -n` numbering. `$VAR` references stay.
    pattern:
      /^((?:[ \t]*\d+[|:\t])?[ \t]*(?:[+-][ \t]*)?(?:(?:export|declare[ \t]+-x)[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(?:(["'])([^"'\n]*)\4|([^\s#'"]+))/gm,
    replace: (match, lead = "", name = "", equals = "", quote = "", quoted, bare) => {
      if (!SECRET_ENV_NAME.test(name)) {
        return match;
      }
      const value = quoted ?? bare ?? "";
      return redactedAssignment(name, `${lead}${name}${equals}${quote}`, value, quote) ?? match;
    },
  },
  {
    // Quoted secret-named literals in JSON, YAML and source: `"apiKey": "..."`, `token: '...'`.
    pattern: /(["']?)([A-Za-z0-9_.-]+)\1([ \t]*[:=][ \t]*)(["'])([^"'\s]{8,})\4/g,
    replace: (match, quote = "", name = "", separator = "", valueQuote = "", value = "") => {
      if (!SECRET_KEY_NAME.test(name)) {
        return match;
      }
      return (
        redactedAssignment(
          name,
          `${quote}${name}${quote}${separator}${valueQuote}`,
          value,
          valueQuote,
        ) ?? match
      );
    },
  },
  {
    pattern: /\b(Bearer|Basic|token)([ \t]+)([A-Za-z0-9._~+/-]{16,}=*)/g,
    replace: (match, scheme = "", space = "", value = "") =>
      containsRedactionPlaceholder(value)
        ? match
        : `${scheme}${space}${redactionPlaceholder("credential")}`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)@/gi,
    replace: (_match, lead = "") => `${lead}${redactionPlaceholder("password")}@`,
  },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: () => redactionPlaceholder("anthropic-key") },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: () => redactionPlaceholder("api-key") },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replace: () => redactionPlaceholder("github-token"),
  },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: () => redactionPlaceholder("npm-token") },
  {
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => redactionPlaceholder("slack-token"),
  },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: () => redactionPlaceholder("aws-key") },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => redactionPlaceholder("google-key") },
  {
    pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/g,
    replace: () => redactionPlaceholder("stripe-key"),
  },
  {
    pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    replace: () => redactionPlaceholder("telegram-token"),
  },
];

/** `text` with every known secret value and every recognizable secret replaced by a placeholder. */
export function redactSecretText(text: string, known: readonly KnownSecret[]): string {
  let redacted = text;
  for (const secret of known) {
    if (redacted.includes(secret.value)) {
      redacted = redacted.split(secret.value).join(redactionPlaceholder(secret.name));
    }
  }
  for (const shape of SECRET_SHAPES) {
    redacted = redacted.replace(shape.pattern, shape.replace);
  }
  return redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of `value` with `redactSecretText` applied to every string inside its arrays and plain
 * objects. Binary data and class instances are returned as they are.
 */
export function redactSecretsDeep<T>(value: T, known: readonly KnownSecret[]): T {
  if (typeof value === "string") {
    return redactSecretText(value, known) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSecretsDeep(item, known)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, redactSecretsDeep(nested, known)]),
    ) as T;
  }
  return value;
}

/**
 * `result` with every secret value replaced, before anything logs it or shows it to the model, the
 * transcript or an approver. An approval request's `executeArgs` are kept as the model wrote them:
 * they are what runs once approved.
 */
export function redactToolResult(
  result: ToolExecutionResult,
  known: readonly KnownSecret[],
): ToolExecutionResult {
  const payload = isApprovalRequiredResult(result.result)
    ? {
        ...redactSecretsDeep({ ...result.result, executeArgs: {} }, known),
        executeArgs: result.result.executeArgs,
      }
    : redactSecretsDeep(result.result, known);
  return {
    ...result,
    result: payload,
    ...(result.error !== undefined ? { error: redactSecretText(result.error, known) } : {}),
  };
}

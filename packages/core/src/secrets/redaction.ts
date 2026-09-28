/**
 * Secret redaction for text that leaves a tool: what the model, the transcript, the logs and any
 * notification see.
 *
 * Files are read as they are, whoever wrote them. What is withheld is the secret values inside
 * them, in two passes:
 *
 * - Known values: every secret Jazz holds (config secret paths, peer and webhook tokens, notify
 *   target secrets and the daemon's tokens, resolved from the keyring and the environment) and
 *   every secret-named environment variable of this process. An exact match is replaced
 *   wherever it appears, in any file or command output.
 * - Recognizable shapes: provider key formats, JWTs, chat webhook URLs, private key blocks,
 *   `NAME=value` and YAML `name: value` lines whose name says secret, quoted secret-named
 *   literals (JSON-escaped too), `.netrc` passwords, bearer credentials and passwords in URLs,
 *   with terminal colour codes around any of them. This is what covers `.env`, `.zshrc` and
 *   other files holding secrets Jazz never saw.
 *
 * Structured results are also redacted by key: a string under a secret-named key
 * (`access_token`, `client_secret`) is replaced whole.
 *
 * A secret the model transforms before it reaches a tool result (base64 in a shell pipeline, for
 * one) is not recognized by either pass.
 */

import { isMcpServerSecretPath, isSecretEnvVarName, isSecretPath } from "@/core/secrets/registry";
import {
  containsRedactionPlaceholder,
  isSecretName,
  PLACEHOLDER_PREFIX,
  redactionPlaceholder,
} from "@/core/secrets/secret-names";
import { isApprovalRequiredResult, type ToolExecutionResult } from "@/core/types/tools";

export { containsRedactionPlaceholder, redactionPlaceholder };

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

/**
 * Why writing `text` as `field` of `tool` would put a placeholder where a real secret belongs, or
 * undefined when it would not.
 *
 * Tool output shows secrets as placeholders, so text copied from it and written back would
 * replace the real value. Only a placeholder naming a secret the target file holds
 * (`currentContent`, when the file exists) or a secret Jazz knows counts; other placeholder-shaped
 * text, such as documentation of this feature, is written as it is.
 */
export function redactedWriteProblem(input: {
  readonly tool: "write_file" | "edit_file";
  readonly field: string;
  readonly text: string;
  readonly currentContent: string | undefined;
  readonly known: readonly KnownSecret[];
}): string | undefined {
  if (!containsRedactionPlaceholder(input.text)) {
    return undefined;
  }
  const placeholderPattern = new RegExp(`\\${PLACEHOLDER_PREFIX}([^\\]\\n]*)\\]`, "g");
  const namesIn = (text: string): string[] =>
    [...text.matchAll(placeholderPattern)].map((match) => match[1] ?? "");
  const secretNames = new Set(input.known.map((secret) => secret.name));
  if (input.currentContent !== undefined) {
    for (const name of namesIn(redactSecretText(input.currentContent, input.known))) {
      secretNames.add(name);
    }
  }
  const standIns = [...new Set(namesIn(input.text).filter((name) => secretNames.has(name)))];
  if (standIns.length === 0) {
    return undefined;
  }
  const named = standIns.map(redactionPlaceholder).join(", ");
  const remedy =
    input.tool === "write_file"
      ? "Use edit_file to change the other lines, and leave the lines showing placeholders as they are."
      : "Keep the lines showing placeholders out of every pattern, replacement and content, and edit the lines around them.";
  return `${input.field} carries ${named}, which stands for a secret value you were shown redacted; writing it would replace the real value. ${remedy}`;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith("./");
}

/** Values that stand for no secret: booleans, null and their YAML spellings. */
const NON_SECRET_LITERALS: ReadonlySet<string> = new Set([
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "null",
  "nil",
  "none",
  "undefined",
  "~",
]);

/** `<your-key>`, `{{ .Values.token }}`, `${TOKEN}`, `xxxxxxxx`, `********`. */
const TEMPLATE_OR_FILLER_VALUE = /^(?:<[^<>]*>|\{\{.*\}\}|\$.*|(.)\1{2,})$/s;

/**
 * Whether `value` could be a secret at all: not empty, not a `$VAR` reference, a template, a
 * `<placeholder>` or repeated filler, not a path, a boolean or null, and not already redacted.
 */
function isRedactableValue(value: string): boolean {
  return (
    value !== "" &&
    !TEMPLATE_OR_FILLER_VALUE.test(value) &&
    !looksLikePath(value) &&
    !NON_SECRET_LITERALS.has(value.toLowerCase()) &&
    !containsRedactionPlaceholder(value)
  );
}

function lastPathSegment(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

/**
 * Whether the config string at `path` is a secret to replace everywhere. An MCP server's env var
 * or header counts only when its name says secret: those maps also carry `LOG_LEVEL`,
 * `Content-Type` and working directories, which would otherwise be replaced in ordinary text.
 */
function isKnownConfigSecret(path: string, value: string): boolean {
  if (!isSecretPath(path) || looksLikePath(value.trim())) {
    return false;
  }
  return !isMcpServerSecretPath(path) || isSecretName(lastPathSegment(path));
}

function collectConfigSecrets(value: unknown, prefix: string, into: KnownSecret[]): void {
  if (typeof value === "string") {
    if (prefix !== "" && isKnownConfigSecret(prefix, value)) {
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
 * resolved config, with keyring and environment values filled in), every secret in `held` (the
 * ones Jazz keeps outside the config, such as peer tokens), and every environment variable whose
 * name says secret. Longest first, so a value containing another is replaced whole.
 */
export function collectKnownSecrets(
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
  held: readonly KnownSecret[] = [],
): KnownSecret[] {
  const found: KnownSecret[] = [];
  collectConfigSecrets(config, "", found);
  for (const secret of held) {
    if (!looksLikePath(secret.value.trim())) {
      found.push(secret);
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isSecretEnvVarName(name) && !looksLikePath(value)) {
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

/** The assignment with its value replaced, or undefined when the value cannot be a secret. */
function redactedAssignment(
  name: string,
  prefix: string,
  value: string,
  suffix = "",
): string | undefined {
  if (!isRedactableValue(value)) {
    return undefined;
  }
  return `${prefix}${redactionPlaceholder(name)}${suffix}`;
}

/**
 * Longest variable or key name a shape reads. Bounding it keeps every shape linear on a long run
 * of name characters, such as minified code or a base64 blob.
 */
const MAX_SECRET_NAME_LENGTH = 128;

/** Longest URL scheme, user name or password a URL-credential match reads. */
const MAX_URL_PART_LENGTH = 256;

/** Terminal colour codes (SGR escapes), which diffs and coloured command output put around text. */
const SGR = String.raw`(?:\x1b\[[0-9;]*m)*`;

/** The name of a variable or key, bounded. */
const NAME = `[A-Za-z_][A-Za-z0-9_]{0,${String(MAX_SECRET_NAME_LENGTH - 1)}}`;

/** A key in JSON, YAML or source, which may also hold `.` and `-`: `client-secret`, `db.password`. */
const KEY_NAME = `[A-Za-z0-9_.-]{1,${String(MAX_SECRET_NAME_LENGTH)}}`;

/** What may start a line before a name: read_file's `N|` or `cat -n` numbering, a diff marker, a list dash. */
const LINE_LEAD =
  String.raw`${SGR}(?:[ \t]*\d+[|:\t])?${SGR}[ \t]*(?:[+-]${SGR}[ \t]*)?(?:-[ \t]+)?` +
  String.raw`(?:(?:export|declare[ \t]+-x)[ \t]+)?${SGR}`;

/** An unquoted value: up to whitespace, a comment, a quote or a colour code. */
const BARE_VALUE = String.raw`[^\s#'"\x1b]+`;

/** Replaces the value of a `NAME=value` or `name: value` match when `isSecret` accepts the name. */
function secretNamedAssignment(isSecret: (name: string) => boolean) {
  return (
    match: string,
    lead = "",
    name = "",
    separator = "",
    quote = "",
    quoted?: string,
    bare?: string,
  ) => {
    if (!isSecret(name)) {
      return match;
    }
    const value = quoted ?? bare ?? "";
    return redactedAssignment(name, `${lead}${name}${separator}${quote}`, value, quote) ?? match;
  };
}

const SECRET_SHAPES: readonly SecretShape[] = [
  {
    pattern:
      /-----BEGIN ((?:[A-Z]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/g,
    replace: () => redactionPlaceholder("private-key"),
  },
  {
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
    replace: () => redactionPlaceholder("jwt"),
  },
  {
    pattern:
      /\bhttps:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
    replace: () => redactionPlaceholder("discord-webhook"),
  },
  {
    pattern: /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]+/g,
    replace: () => redactionPlaceholder("slack-webhook"),
  },
  {
    pattern: new RegExp(
      `^(${LINE_LEAD})(${NAME})([ \\t]*=[ \\t]*)(?:(["'])([^"'\\n]*)\\4|(${BARE_VALUE}))`,
      "gm",
    ),
    replace: secretNamedAssignment(isSecretEnvVarName),
  },
  {
    pattern: new RegExp(
      `^(${LINE_LEAD})(${KEY_NAME})([ \\t]*:[ \\t]+)(?:(["'])([^"'\\n]*)\\4|(${BARE_VALUE}))(?=${SGR}[ \\t]*(?:#.*)?$)`,
      "gm",
    ),
    replace: secretNamedAssignment(isSecretName),
  },
  {
    pattern: new RegExp(
      `(?<![A-Za-z0-9_.\\\\-])(\\\\?["']?)(${KEY_NAME})\\1([ \\t]*[:=][ \\t]*)(\\\\?["'])([^"'\\s\\\\\\x1b]{8,})\\4`,
      "g",
    ),
    replace: (match, quote = "", name = "", separator = "", valueQuote = "", value = "") => {
      if (!isSecretName(name)) {
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
    pattern:
      /^([ \t]*password[ \t]+)(\S+)(?=[ \t]*$)|(\blogin[ \t]+\S+[ \t]+password[ \t]+)(\S+)/gm,
    replace: (match, lineLead, lineValue, inlineLead, inlineValue) => {
      const lead = lineLead ?? inlineLead ?? "";
      const value = lineValue ?? inlineValue ?? "";
      return isRedactableValue(value) ? `${lead}${redactionPlaceholder("password")}` : match;
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
    pattern: new RegExp(
      `(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,${String(MAX_URL_PART_LENGTH)}}:\\/\\/[^\\s:/@]{1,${String(MAX_URL_PART_LENGTH)}}:)([^\\s@/]{1,${String(MAX_URL_PART_LENGTH)}})@`,
      "gi",
    ),
    replace: (match, lead = "", password = "") =>
      containsRedactionPlaceholder(password)
        ? match
        : `${lead}${redactionPlaceholder("password")}@`,
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
 * objects, and every string under a secret-named key (`access_token`, `clientSecret`) replaced
 * whole by that key's placeholder. Binary data and class instances are returned as they are.
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
      Object.entries(value).map(([key, nested]) => [
        key,
        typeof nested === "string" && isSecretName(key) && isRedactableValue(nested.trim())
          ? redactionPlaceholder(key)
          : redactSecretsDeep(nested, known),
      ]),
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

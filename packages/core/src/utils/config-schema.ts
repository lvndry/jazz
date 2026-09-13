/**
 * The schema of a Jazz config file — `~/.jazz/config.json`, or a project's `./.jazz/config.json` —
 * and the three boundaries that check values against it.
 *
 * `AppConfig` is the merged, defaulted runtime view. A single file differs from it in three ways:
 * every field is optional, because a file is a partial override; `mcpServers` holds only the
 * `enabled`/`trusted` overrides Jazz owns, because full server definitions live in
 * `.agents/mcp.json`; and `daemon.token` may appear, the one secret whose no-keyring fallback
 * lands in this file under a section `AppConfig` does not model.
 *
 * - `parseConfigFile` checks a file as loaded. An invalid value or unknown key is removed and
 *   reported, never thrown: a daemon or a scheduled run has nobody to read a refusal, and running
 *   on a default beats not running. `formatConfigIssues` renders the report.
 * - `parseConfigInput` turns one `jazz config set` argument, which is always a string, into the
 *   type its path declares — or says why it cannot.
 * - `checkConfigWrite` checks a value an internal caller hands `AgentConfigService.set`.
 *
 * Every section's shape is declared `satisfies SchemaShape<...>` against its interface, and every
 * closed string union goes through `exhaustiveEnum`. Adding a field or a union member to the types
 * without adding it here, or giving it a different type, is therefore a compile error rather than
 * a setting that silently never loads.
 */

import { z } from "zod";
import { AVAILABLE_PROVIDERS } from "@/core/constants/models";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import type {
  AnthropicProviderConfig,
  AppConfig,
  ContextConfig,
  LLMConfig,
  LLMProviderConfig,
  LlamaCppProviderConfig,
  LoggingConfig,
  MCPServerOverride,
  NotificationsConfig,
  OllamaProviderConfig,
  OtlpTelemetryConfig,
  SchedulerConfig,
  SchedulerMode,
  StorageConfig,
  TelemetryConfig,
  WebSearchConfig,
} from "@/core/types/config";
import { WEB_SEARCH_PROVIDERS } from "@/core/types/config";
import { DISCLOSURE_TIERS } from "@/core/types/disclosure-tier";
import type { ColorProfile, OutputConfig, OutputMode } from "@/core/types/output";
import type { PeerConfig } from "@/core/types/peer";
import type { StreamingConfig } from "@/core/types/streaming";
import type { WebhookConfig, WebhookConversationMode } from "@/core/types/webhook";

/**
 * `T` with every property optional, all the way down. A file is a partial override, so this is what
 * one may hold; fields are `.exactOptional()` so the parsed result assigns straight into `AppConfig`
 * under `exactOptionalPropertyTypes`.
 */
type FileShape<T> = T extends readonly (infer Element)[]
  ? readonly FileShape<Element>[]
  : T extends object
    ? { readonly [K in keyof T]?: FileShape<Exclude<T[K], undefined>> }
    : T;

/** One zod schema per key of `T`, each producing that key's value — no key missing, none extra. */
type SchemaShape<T> = {
  readonly [K in keyof T]-?: z.ZodType<FileShape<Exclude<T[K], undefined>> | undefined>;
};

/** Every key of every member of a union, each optional: how a partial file spells a tagged union. */
type Flatten<U> = {
  readonly [K in U extends unknown ? keyof U : never]?: U extends unknown
    ? K extends keyof U
      ? U[K]
      : never
    : never;
};

/** Everything one config file may hold. The file comment explains how it differs from `AppConfig`. */
export interface ConfigFileContents extends Omit<AppConfig, "storage" | "mcpServers"> {
  readonly storage?: Flatten<StorageConfig>;
  readonly mcpServers?: Readonly<Record<string, MCPServerOverride>>;
  readonly daemon?: { readonly token?: string };
}

/**
 * `z.enum` over a string union that refuses, at compile time, a list leaving a member out: the
 * missing members become a required second argument, so the call fails to type-check and names them.
 */
function exhaustiveEnum<T extends string>() {
  return <const V extends readonly [T, ...T[]]>(
    values: V,
    ..._missing: [Exclude<T, V[number]>] extends [never] ? [] : [missing: Exclude<T, V[number]>]
  ) => z.enum(values);
}

const text = z.string();
const flag = z.boolean();
const wholeNumber = z.int().nonnegative();
const names = z.array(z.string());

const storageShape = {
  type: exhaustiveEnum<StorageConfig["type"]>()(["file", "database"]).exactOptional(),
  path: text.exactOptional(),
  connectionString: text.exactOptional(),
} satisfies SchemaShape<Flatten<StorageConfig>>;

const loggingShape = {
  level: exhaustiveEnum<LoggingConfig["level"]>()([
    "debug",
    "info",
    "warn",
    "error",
  ]).exactOptional(),
  format: exhaustiveEnum<LoggingConfig["format"]>()(["json", "plain"]).exactOptional(),
} satisfies SchemaShape<LoggingConfig>;

const apiKeyOnly = z
  .strictObject({ api_key: text.exactOptional() } satisfies SchemaShape<LLMProviderConfig>)
  .exactOptional();

const llmShape = {
  streamIdleTimeoutMs: z.int().positive().exactOptional(),
  ai_gateway: apiKeyOnly,
  alibaba: apiKeyOnly,
  anthropic: z
    .strictObject({
      api_key: text.exactOptional(),
      workspace_id: text.exactOptional(),
    } satisfies SchemaShape<AnthropicProviderConfig>)
    .exactOptional(),
  cerebras: apiKeyOnly,
  deepseek: apiKeyOnly,
  fireworks: apiKeyOnly,
  gemini: apiKeyOnly,
  groq: apiKeyOnly,
  llamacpp: z
    .strictObject({
      api_key: text.exactOptional(),
      base_url: text.exactOptional(),
    } satisfies SchemaShape<LlamaCppProviderConfig>)
    .exactOptional(),
  minimax: apiKeyOnly,
  mistral: apiKeyOnly,
  moonshotai: apiKeyOnly,
  ollama: z
    .strictObject({
      api_key: text.exactOptional(),
      base_url: text.exactOptional(),
      keep_alive: text.exactOptional(),
    } satisfies SchemaShape<OllamaProviderConfig>)
    .exactOptional(),
  openai: apiKeyOnly,
  openrouter: apiKeyOnly,
  togetherai: apiKeyOnly,
  xai: apiKeyOnly,
  zhipuai: apiKeyOnly,
} satisfies SchemaShape<LLMConfig> & Record<(typeof AVAILABLE_PROVIDERS)[number], unknown>;

const webSearchShape = {
  exa: apiKeyOnly,
  parallel: apiKeyOnly,
  tavily: apiKeyOnly,
  brave: apiKeyOnly,
  perplexity: apiKeyOnly,
  linkup: apiKeyOnly,
  provider: z.enum(WEB_SEARCH_PROVIDERS).exactOptional(),
} satisfies SchemaShape<WebSearchConfig>;

const streamingShape = {
  enabled: z.union([flag, z.literal("auto")]).exactOptional(),
  textBufferMs: wholeNumber.exactOptional(),
} satisfies SchemaShape<StreamingConfig>;

const outputShape = {
  showReasoning: flag.exactOptional(),
  showToolExecution: flag.exactOptional(),
  collapseReasoning: flag.exactOptional(),
  mode: exhaustiveEnum<OutputMode>()(["rendered", "hybrid", "raw", "quiet"]).exactOptional(),
  colorProfile: exhaustiveEnum<ColorProfile>()(["full", "basic", "none"]).exactOptional(),
  showMetrics: flag.exactOptional(),
  streaming: z.strictObject(streamingShape).exactOptional(),
} satisfies SchemaShape<OutputConfig>;

const notificationsShape = {
  enabled: flag.exactOptional(),
  sound: flag.exactOptional(),
} satisfies SchemaShape<NotificationsConfig>;

type OtlpSignal = NonNullable<OtlpTelemetryConfig["signals"]>[number];

const otlpShape = {
  enabled: flag.exactOptional(),
  signals: z.array(exhaustiveEnum<OtlpSignal>()(["traces", "logs"])).exactOptional(),
  endpoint: text.exactOptional(),
  tracesEndpoint: text.exactOptional(),
  logsEndpoint: text.exactOptional(),
  headers: z.record(z.string(), text).exactOptional(),
  serviceName: text.exactOptional(),
  captureContent: flag.exactOptional(),
  timeoutMs: wholeNumber.exactOptional(),
} satisfies SchemaShape<OtlpTelemetryConfig>;

const telemetryShape = {
  enabled: flag.exactOptional(),
  storagePath: text.exactOptional(),
  bufferSize: wholeNumber.exactOptional(),
  flushIntervalMs: wholeNumber.exactOptional(),
  retentionDays: wholeNumber.exactOptional(),
  otlp: z.strictObject(otlpShape).exactOptional(),
} satisfies SchemaShape<TelemetryConfig>;

const contextShape = {
  warnThresholdRatio: z.number().exactOptional(),
  compactThresholdRatio: z.number().exactOptional(),
} satisfies SchemaShape<ContextConfig>;

const schedulerShape = {
  mode: exhaustiveEnum<SchedulerMode>()(["auto", "in-process"]).exactOptional(),
} satisfies SchemaShape<SchedulerConfig>;

const mcpOverrideShape = {
  enabled: flag.exactOptional(),
  trusted: flag.exactOptional(),
} satisfies SchemaShape<MCPServerOverride>;

const peerShape = {
  name: z.string().min(1),
  url: text.exactOptional(),
  disclosure: z.enum(DISCLOSURE_TIERS).exactOptional(),
  persona: text.exactOptional(),
  allow: names.exactOptional(),
} satisfies SchemaShape<PeerConfig>;

const webhookShape = {
  name: z.string().min(1),
  agentId: z.string().min(1),
  promptTemplate: text,
  description: text.exactOptional(),
  conversation: exhaustiveEnum<WebhookConversationMode>()([
    "ephemeral",
    "threaded",
  ]).exactOptional(),
  disclosure: z.enum(DISCLOSURE_TIERS).exactOptional(),
  allow: names.exactOptional(),
} satisfies SchemaShape<WebhookConfig>;

const configFileShape = {
  storage: z.strictObject(storageShape).exactOptional(),
  logging: z.strictObject(loggingShape).exactOptional(),
  llm: z.strictObject(llmShape).exactOptional(),
  web_search: z.strictObject(webSearchShape).exactOptional(),
  output: z.strictObject(outputShape).exactOptional(),
  mcpServers: z.record(z.string(), z.strictObject(mcpOverrideShape)).exactOptional(),
  notifications: z.strictObject(notificationsShape).exactOptional(),
  autoApprovedCommands: names.exactOptional(),
  telemetry: z.strictObject(telemetryShape).exactOptional(),
  maxRetries: wholeNumber.exactOptional(),
  maxSubagentDepth: wholeNumber.exactOptional(),
  maxIterations: wholeNumber.exactOptional(),
  maxSubagentIterations: wholeNumber.exactOptional(),
  maxCostUSD: z.number().nonnegative().exactOptional(),
  maxTokens: wholeNumber.exactOptional(),
  maxDurationMs: wholeNumber.exactOptional(),
  context: z.strictObject(contextShape).exactOptional(),
  workspaceMaxTotalBytesPerAgent: wholeNumber.exactOptional(),
  scheduler: z.strictObject(schedulerShape).exactOptional(),
  peers: z.array(z.strictObject(peerShape)).exactOptional(),
  webhooks: z.array(z.strictObject(webhookShape)).exactOptional(),
  daemon: z.strictObject({ token: text.exactOptional() }).exactOptional(),
} satisfies SchemaShape<ConfigFileContents>;

/** A whole config file, as it may appear on disk. */
export const ConfigFileSchema = z.strictObject(configFileShape);

/** A config file after `parseConfigFile`: only valid values, only known keys. */
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** The runtime shape `mcpServers` merges into; re-exported so callers need not know both modules. */
export type { MCPServerConfig };

type Path = readonly PropertyKey[];

/** Strip `.exactOptional()`, which never changes what a present value must look like. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodExactOptional || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

function childSchema(schema: z.ZodType, segment: PropertyKey): z.ZodType | undefined {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) {
    return typeof segment === "string" && Object.hasOwn(inner.shape, segment)
      ? (inner.shape[segment] as z.ZodType)
      : undefined;
  }
  if (inner instanceof z.ZodRecord) {
    return typeof segment === "string" ? (inner.valueType as z.ZodType) : undefined;
  }
  if (inner instanceof z.ZodArray) {
    return typeof segment === "number" ? (inner.element as z.ZodType) : undefined;
  }
  return undefined;
}

function schemaAt(path: Path): z.ZodType | undefined {
  let current: z.ZodType | undefined = ConfigFileSchema;
  for (const segment of path) {
    if (current === undefined) return undefined;
    current = childSchema(current, segment);
  }
  return current;
}

/** Render a path the way a person would type it: `webhooks[1].promptTemplate`. */
export function formatConfigPath(path: Path): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}

function describeNumber(schema: z.ZodNumber): string {
  const kind = schema.isInt ? "a whole number" : "a number";
  const bag = schema._zod.bag;
  if (bag.exclusiveMinimum === 0) return `${kind} greater than 0`;
  if (bag.minimum === 0) return `${kind} of 0 or more`;
  return kind;
}

function alternatives(schema: z.ZodType): string[] {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodBoolean) return ["true", "false"];
  if (inner instanceof z.ZodEnum) return inner.options.map(String);
  if (inner instanceof z.ZodLiteral) return [...inner.values].map(String);
  if (inner instanceof z.ZodUnion) {
    return (inner.options as readonly z.ZodType[]).flatMap(alternatives);
  }
  if (inner instanceof z.ZodNumber) return [describeNumber(inner)];
  if (inner instanceof z.ZodString) return ["text"];
  if (inner instanceof z.ZodArray) return ["a list"];
  return ["an object"];
}

/** What a value at this schema must look like, in words: "a whole number of 0 or more". */
function describeExpected(schema: z.ZodType | undefined): string {
  return schema === undefined ? "nothing (not a setting)" : formatList(alternatives(schema));
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0] as number;
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j] as number;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(above + 1, (previous[j - 1] as number) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length] as number;
}

/** The known key a typo most plausibly meant, if any is close enough to be worth suggesting. */
function closestKey(typed: string, known: readonly string[]): string | undefined {
  const lowered = typed.toLowerCase();
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(typed.length / 3)) + 1;
  for (const candidate of known) {
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function knownKeysAt(path: Path): readonly string[] {
  const schema = schemaAt(path);
  const inner = schema === undefined ? undefined : unwrap(schema);
  return inner instanceof z.ZodObject ? Object.keys(inner.shape) : [];
}

/** One thing `parseConfigFile` removed, and why. */
export type ConfigIssue =
  | {
      readonly kind: "unknown-key";
      /** Where the key was. */
      readonly path: string;
      /** What was removed: the key itself, or the whole list entry it sat in. */
      readonly removed: string;
      /** The setting a typo most plausibly meant. */
      readonly suggestion?: string;
    }
  | {
      readonly kind: "invalid-value";
      readonly path: string;
      readonly removed: string;
      /** What the value had to be, in words. */
      readonly expected: string;
      /** What the file actually held; `undefined` when a required field was missing. */
      readonly actual: unknown;
    };

export interface ConfigFileParse {
  readonly config: ConfigFile;
  readonly issues: readonly ConfigIssue[];
}

/**
 * Where to cut for a problem at `path`: the whole list entry when the problem is inside one, since
 * a webhook or peer missing a field is not a smaller webhook or peer but a broken one.
 */
function removalPath(path: Path): Path {
  const index = path.findIndex((segment) => typeof segment === "number");
  return index === -1 ? path : path.slice(0, index + 1);
}

function removeAll(root: Record<string, unknown>, paths: readonly Path[]): void {
  const listRemovals = new Map<unknown[], Set<number>>();
  for (const path of paths) {
    let parent: unknown = root;
    for (const segment of path.slice(0, -1)) {
      parent =
        parent !== null && typeof parent === "object"
          ? (parent as Record<PropertyKey, unknown>)[segment]
          : undefined;
    }
    const last = path[path.length - 1];
    if (last === undefined || parent === null || typeof parent !== "object") continue;
    if (Array.isArray(parent) && typeof last === "number") {
      const indices = listRemovals.get(parent) ?? new Set<number>();
      indices.add(last);
      listRemovals.set(parent, indices);
    } else {
      delete (parent as Record<PropertyKey, unknown>)[last];
    }
  }
  for (const [list, indices] of listRemovals) {
    for (const index of [...indices].sort((left, right) => right - left)) {
      list.splice(index, 1);
    }
  }
}

/** Removal can only shrink the input, so a pass that finds nothing new to remove never repeats. */
const MAX_PARSE_PASSES = 16;

/**
 * Check one config file, removing whatever does not fit the schema and reporting each removal.
 *
 * Removal happens in passes because zod reports a problem inside a list entry and a problem with
 * the entry's siblings independently; cutting everything reported and parsing again converges on
 * the largest valid subset of the file. The input is never mutated.
 */
export function parseConfigFile(contents: Readonly<Record<string, unknown>>): ConfigFileParse {
  const working = structuredClone(contents) as Record<string, unknown>;
  const issues: ConfigIssue[] = [];

  for (let pass = 0; pass < MAX_PARSE_PASSES; pass++) {
    const result = ConfigFileSchema.safeParse(working, { reportInput: true });
    if (result.success) return { config: result.data, issues };

    const removals: Path[] = [];
    for (const issue of result.error.issues) {
      if (issue.code === "unrecognized_keys") {
        const known = knownKeysAt(issue.path);
        for (const key of issue.keys) {
          const path = [...issue.path, key];
          const removed = removalPath(path);
          const suggestion = closestKey(key, known);
          issues.push({
            kind: "unknown-key",
            path: formatConfigPath(path),
            removed: formatConfigPath(removed),
            ...(suggestion !== undefined
              ? { suggestion: formatConfigPath([...issue.path, suggestion]) }
              : {}),
          });
          removals.push(removed);
        }
        continue;
      }
      const removed = removalPath(issue.path);
      issues.push({
        kind: "invalid-value",
        path: formatConfigPath(issue.path),
        removed: formatConfigPath(removed),
        expected: describeExpected(schemaAt(issue.path)),
        actual: issue.input,
      });
      removals.push(removed);
    }

    if (removals.some((path) => path.length === 0)) return { config: {}, issues };
    removeAll(working, removals);
  }

  return { config: {}, issues };
}

function describeActual(actual: unknown, redacted: boolean): string {
  if (actual === undefined) return "nothing";
  if (redacted) return Array.isArray(actual) ? "a list" : `a ${typeof actual}`;
  const rendered = JSON.stringify(actual) ?? `a ${typeof actual}`;
  return rendered.length > 60 ? `${rendered.slice(0, 57)}...` : rendered;
}

/**
 * Render `parseConfigFile`'s report as one block for stderr, or `undefined` when there is nothing
 * to say.
 *
 * `isSecretPath` comes from the caller because the secret registry lives with the config service,
 * not in core; a value found at a secret path is described by its type and never echoed.
 */
export function formatConfigIssues(
  filePath: string,
  issues: readonly ConfigIssue[],
  isSecretPath: (path: string) => boolean,
): string | undefined {
  if (issues.length === 0) return undefined;
  const lines = issues.map((issue) => {
    const entry = issue.removed === issue.path ? "" : ` (${issue.removed} is ignored as a whole)`;
    if (issue.kind === "unknown-key") {
      const hint = issue.suggestion === undefined ? "" : ` — did you mean ${issue.suggestion}?`;
      return `  ${issue.path}: not a setting${hint}${entry}`;
    }
    const actual = describeActual(issue.actual, isSecretPath(issue.path));
    return `  ${issue.path}: expected ${issue.expected}, got ${actual}${entry}`;
  });
  const noun = issues.length === 1 ? "entry" : "entries";
  return `jazz: ignoring ${issues.length} ${noun} in ${filePath}; defaults apply instead:\n${lines.join("\n")}\n`;
}

/** How `jazz config set` should treat a path: a single value, a section, or not a setting at all. */
export type ConfigPathResolution =
  | { readonly known: true; readonly structured: boolean }
  | { readonly known: false; readonly suggestion?: string };

function parsePath(path: string): readonly string[] | undefined {
  const segments = path.split(".");
  return segments.every((segment) => segment !== "") ? segments : undefined;
}

function isStructured(schema: z.ZodType): boolean {
  const inner = unwrap(schema);
  return (
    inner instanceof z.ZodObject || inner instanceof z.ZodRecord || inner instanceof z.ZodArray
  );
}

function suggestPath(segments: readonly string[]): string | undefined {
  for (let depth = 0; depth < segments.length; depth++) {
    const prefix = segments.slice(0, depth);
    const segment = segments[depth] as string;
    if (schemaAt([...prefix, segment]) !== undefined) continue;
    const guess = closestKey(segment, knownKeysAt(prefix));
    if (guess === undefined) return undefined;
    const suggested = [...prefix, guess, ...segments.slice(depth + 1)];
    return schemaAt(suggested) === undefined ? undefined : suggested.join(".");
  }
  return undefined;
}

/**
 * Whether a dotted path names something in a config file. List entries are not addressable by
 * index: `peers` and `webhooks` are replaced whole, never patched one field at a time.
 */
export function resolveConfigPath(path: string): ConfigPathResolution {
  const segments = parsePath(path);
  if (segments === undefined) return { known: false };
  const schema = schemaAt(segments);
  if (schema === undefined) {
    const suggestion = suggestPath(segments);
    return suggestion === undefined ? { known: false } : { known: false, suggestion };
  }
  return { known: true, structured: isStructured(schema) };
}

/** The broad kind of value a setting holds, for choosing how to explain a refusal. */
export type ConfigValueKind = "whole-number" | "number" | "boolean" | "choice" | "text";

export type ConfigInput =
  | { readonly ok: true; readonly value: string | number | boolean }
  | { readonly ok: false; readonly reason: "unknown-key"; readonly suggestion?: string }
  | { readonly ok: false; readonly reason: "structured" }
  | {
      readonly ok: false;
      readonly reason: "invalid";
      readonly expected: string;
      readonly kind: ConfigValueKind;
    };

function valueKind(schema: z.ZodType): ConfigValueKind {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodNumber) return inner.isInt ? "whole-number" : "number";
  if (inner instanceof z.ZodBoolean) return "boolean";
  if (inner instanceof z.ZodString) return "text";
  return "choice";
}

const TRUE_LITERALS: ReadonlySet<string> = new Set(["true", "yes", "on", "1"]);
const FALSE_LITERALS: ReadonlySet<string> = new Set(["false", "no", "off", "0"]);

function readings(raw: string): readonly (string | number | boolean)[] {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  const out: (string | number | boolean)[] = [raw, lowered];
  if (TRUE_LITERALS.has(lowered)) out.push(true);
  if (FALSE_LITERALS.has(lowered)) out.push(false);
  // Number() rather than parseFloat: "600000ms" must be refused, not read as its prefix.
  const numeric = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(numeric)) out.push(numeric);
  return out;
}

/**
 * Read one `jazz config set` argument as the type its path declares.
 *
 * Each plausible reading of the string is tried against the setting's schema, text first, so a
 * text setting keeps exactly what was typed (`keep_alive` stays `"-1"`) while a numeric one gets
 * a number. A value no reading satisfies is refused rather than stored as a string, because a
 * string in a numeric or boolean field is ignored by everything that reads it.
 */
export function parseConfigInput(path: string, raw: string): ConfigInput {
  const resolution = resolveConfigPath(path);
  if (!resolution.known) {
    return resolution.suggestion === undefined
      ? { ok: false, reason: "unknown-key" }
      : { ok: false, reason: "unknown-key", suggestion: resolution.suggestion };
  }
  if (resolution.structured) return { ok: false, reason: "structured" };

  const schema = schemaAt(path.split(".")) as z.ZodType;
  for (const reading of readings(raw)) {
    if (schema.safeParse(reading).success) return { ok: true, value: reading };
  }
  return {
    ok: false,
    reason: "invalid",
    expected: describeExpected(schema),
    kind: valueKind(schema),
  };
}

export type ConfigWriteCheck =
  { readonly ok: true } | { readonly ok: false; readonly problem: string };

/**
 * Check a value bound for `path` before it is written. `undefined` always passes: it clears the
 * setting. Secrets are the caller's to route and are not checked here.
 */
export function checkConfigWrite(path: string, value: unknown): ConfigWriteCheck {
  const segments = parsePath(path);
  const schema = segments === undefined ? undefined : schemaAt(segments);
  if (segments === undefined || schema === undefined) {
    return { ok: false, problem: `"${path}" is not a setting` };
  }
  if (value === undefined) return { ok: true };

  const result = schema.safeParse(value);
  if (result.success) return { ok: true };
  const issue = result.error.issues[0];
  const issuePath = [...segments, ...(issue?.path ?? [])];
  const expected =
    issue?.code === "unrecognized_keys"
      ? `no key named ${issue.keys.map((key) => `"${key}"`).join(", ")}`
      : describeExpected(schemaAt(issuePath));
  return { ok: false, problem: `${formatConfigPath(issuePath)} expected ${expected}` };
}

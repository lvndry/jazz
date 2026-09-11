/**
 * Typing for `jazz config set` values.
 *
 * Everything that reaches Jazz from a shell argument is a string, but most of
 * `AppConfig` is not: `maxRetries` is a number, `output.collapseReasoning` is a
 * boolean, `output.streaming.enabled` is a boolean or the literal "auto".
 * Storing the raw string in config.json produces a file that parses fine and is
 * then silently ignored — `resolveStreamIdleTimeoutMs` only accepts a `number`,
 * `collapseReasoning !== false` is true for the string "false", and the MCP
 * override branch of the config service only records `enabled`/`trusted` when
 * the value is a real boolean.
 *
 * `CONFIG_VALUE_TYPES` names every non-string scalar in `AppConfig`, and
 * `parseConfigValue` converts one CLI argument to it — or reports what the path
 * wanted, so the CLI can refuse the write instead of storing something inert.
 * Paths that are genuinely strings (API keys, paths, enum-ish settings such as
 * `logging.level`) are absent by design and pass through untouched.
 *
 * This is a boundary concern: the config service keeps taking already-typed
 * values from callers that have them, such as the config wizard.
 */

/** The non-string shapes a config value can have. */
export type ConfigValueType = "integer" | "number" | "boolean" | "boolean-or-auto";

/** A parsed config value, ready to hand to `AgentConfigService.set`. */
export type ConfigValue = string | number | boolean;

/**
 * Every non-string scalar in `AppConfig`, keyed by its dotted path. A `*`
 * segment matches exactly one path segment, which is how the per-server MCP
 * overrides are covered without enumerating server names.
 *
 * Keep this in sync with `AppConfig` in `types/config.ts`: a numeric setting
 * missing from here is a setting `jazz config set` writes as a dead string.
 */
export const CONFIG_VALUE_TYPES: Readonly<Record<string, ConfigValueType>> = {
  maxRetries: "integer",
  maxSubagentDepth: "integer",
  maxIterations: "integer",
  maxSubagentIterations: "integer",
  maxCostUSD: "number",
  maxTokens: "integer",
  maxDurationMs: "integer",
  workspaceMaxTotalBytesPerAgent: "integer",
  "context.warnThresholdRatio": "number",
  "context.compactThresholdRatio": "number",
  "llm.streamIdleTimeoutMs": "integer",
  "notifications.enabled": "boolean",
  "notifications.sound": "boolean",
  "output.showReasoning": "boolean",
  "output.showToolExecution": "boolean",
  "output.collapseReasoning": "boolean",
  "output.showMetrics": "boolean",
  "output.streaming.enabled": "boolean-or-auto",
  "output.streaming.textBufferMs": "integer",
  "telemetry.enabled": "boolean",
  "telemetry.bufferSize": "integer",
  "telemetry.flushIntervalMs": "integer",
  "telemetry.retentionDays": "integer",
  "telemetry.otlp.enabled": "boolean",
  "telemetry.otlp.captureContent": "boolean",
  "telemetry.otlp.timeoutMs": "integer",
  "mcpServers.*.enabled": "boolean",
  "mcpServers.*.trusted": "boolean",
};

const WILDCARD_PATTERNS: readonly (readonly [readonly string[], ConfigValueType])[] =
  Object.entries(CONFIG_VALUE_TYPES)
    .filter(([path]) => path.includes("*"))
    .map(([path, type]) => [path.split("."), type] as const);

/**
 * The declared type of a config path, or undefined when the path holds a
 * string (or is not a known setting at all).
 */
export function configValueType(path: string): ConfigValueType | undefined {
  const exact = CONFIG_VALUE_TYPES[path];
  if (exact !== undefined) {
    return exact;
  }

  const segments = path.split(".");
  for (const [pattern, type] of WILDCARD_PATTERNS) {
    if (pattern.length !== segments.length) continue;
    if (pattern.every((segment, index) => segment === "*" || segment === segments[index])) {
      return type;
    }
  }
  return undefined;
}

/** What a value is allowed to look like, for the error a rejected write reports. */
const EXPECTED_DESCRIPTIONS: Readonly<Record<ConfigValueType, string>> = {
  integer: "a whole number",
  number: "a number",
  boolean: "true or false",
  "boolean-or-auto": "true, false, or auto",
};

export type ParsedConfigValue =
  | { readonly ok: true; readonly value: ConfigValue }
  | { readonly ok: false; readonly expected: string; readonly type: ConfigValueType };

const TRUE_LITERALS = new Set(["true", "yes", "on", "1"]);
const FALSE_LITERALS = new Set(["false", "no", "off", "0"]);

/**
 * Convert one raw CLI value to the type its config path declares.
 *
 * A path with no declared type keeps the trimmed string. A declared path that
 * cannot be parsed fails rather than falling back to the string, because the
 * fallback is exactly the silent no-op this function exists to prevent.
 */
export function parseConfigValue(path: string, raw: string): ParsedConfigValue {
  const type = configValueType(path);
  const trimmed = raw.trim();
  if (type === undefined) {
    return { ok: true, value: raw };
  }

  const expected = EXPECTED_DESCRIPTIONS[type];
  const lowered = trimmed.toLowerCase();

  if (type === "boolean" || type === "boolean-or-auto") {
    if (type === "boolean-or-auto" && lowered === "auto") {
      return { ok: true, value: "auto" };
    }
    if (TRUE_LITERALS.has(lowered)) return { ok: true, value: true };
    if (FALSE_LITERALS.has(lowered)) return { ok: true, value: false };
    return { ok: false, expected, type };
  }

  // Number() is deliberate over parseFloat: it rejects trailing garbage
  // ("600000ms") instead of silently accepting the prefix.
  const parsed = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(parsed)) {
    return { ok: false, expected, type };
  }
  if (type === "integer" && !Number.isInteger(parsed)) {
    return { ok: false, expected, type };
  }
  return { ok: true, value: parsed };
}

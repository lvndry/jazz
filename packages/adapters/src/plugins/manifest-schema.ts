/**
 * Strict parsing for executable plugin manifests.
 *
 * Manifests are untrusted install input. This module deliberately accepts a
 * small JSON-only vocabulary, rejects unknown fields, normalizes destinations,
 * and bounds every collection/string before any artifact is fetched or code is
 * imported. The domain types can move to `@jazz/core/types/plugin` without
 * changing this boundary parser.
 */

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_PLUGIN_MANIFEST_BYTES = 128 * 1024;
export const MAX_PLUGIN_ARTIFACT_BYTES = 8 * 1024 * 1024;

const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9.-]{1,126}[a-z0-9])?$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HOOK_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const SECRET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

import type {
  JsonValue,
  PluginCommandDeclaration,
  PluginManifest,
  PluginSecretDeclaration,
  PluginToolDeclaration,
} from "@jazz/core/types/plugin";

export type { PluginManifest, PluginSecretDeclaration } from "@jazz/core/types/plugin";

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0)
    throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max) {
    throw new Error(`${label} must contain 1-${max} characters`);
  }
  if (
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(`${label} contains control characters`);
  }
  return normalized;
}

function uniqueStrings(
  value: unknown,
  label: string,
  options: { readonly maxItems: number; readonly maxLength: number; readonly pattern?: RegExp },
): readonly string[] {
  if (!Array.isArray(value) || value.length > options.maxItems) {
    throw new Error(`${label} must be an array with at most ${options.maxItems} entries`);
  }
  const result = value.map((item, index) => {
    const parsed = boundedString(item, `${label}[${index}]`, options.maxLength);
    if (options.pattern && !options.pattern.test(parsed)) {
      throw new Error(`${label}[${index}] has an invalid format`);
    }
    return parsed;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function normalizeDestination(value: string, label: string): string {
  if (value.includes("://") || value.includes("/") || value.includes("@")) {
    throw new Error(`${label} must be a hostname with optional port, not a URL`);
  }
  let url: URL;
  try {
    url = new URL(`https://${value}`);
  } catch {
    throw new Error(`${label} is not a valid network destination`);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} is not a valid network destination`);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.includes("*") || host === "localhost") {
    throw new Error(`${label} must name an exact non-local hostname`);
  }
  return url.port === "" || url.port === "443" ? host : `${host}:${url.port}`;
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function parseToolDeclaration(value: unknown, index: number): PluginToolDeclaration {
  const item = record(value, `tools[${index}]`);
  exactKeys(item, ["name", "description", "parameters", "riskLevel", "egress"], `tools[${index}]`);
  const name = boundedString(item["name"], `tools[${index}].name`, 64);
  if (!TOOL_NAME.test(name)) throw new Error(`tools[${index}].name has an invalid format`);
  const description = boundedString(item["description"], `tools[${index}].description`, 1024);
  const riskLevel = item["riskLevel"];
  if (riskLevel !== "read-only" && riskLevel !== "low-risk" && riskLevel !== "high-risk") {
    throw new Error(`tools[${index}].riskLevel must be read-only, low-risk, or high-risk`);
  }
  if (typeof item["egress"] !== "boolean")
    throw new Error(`tools[${index}].egress must be boolean`);
  const parameters = record(item["parameters"], `tools[${index}].parameters`) as JsonValue;
  return { name, description, parameters, riskLevel, egress: item["egress"] };
}

function parseTools(value: unknown): readonly PluginToolDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("tools must be an array with at most 32 entries");
  }
  const tools = value.map(parseToolDeclaration);
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("tools contains duplicate names");
  }
  return tools;
}

function parseCommandDeclaration(value: unknown, index: number): PluginCommandDeclaration {
  const item = record(value, `commands[${index}]`);
  exactKeys(item, ["name", "description"], `commands[${index}]`);
  const name = boundedString(item["name"], `commands[${index}].name`, 64);
  if (!TOOL_NAME.test(name)) throw new Error(`commands[${index}].name has an invalid format`);
  const description = boundedString(item["description"], `commands[${index}].description`, 1024);
  return { name, description };
}

function parseCommands(value: unknown): readonly PluginCommandDeclaration[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("commands must be an array with at most 32 entries");
  }
  const commands = value.map(parseCommandDeclaration);
  if (new Set(commands.map((command) => command.name)).size !== commands.length) {
    throw new Error("commands contains duplicate names");
  }
  return commands;
}

function parseSecret(value: unknown, index: number): PluginSecretDeclaration {
  const item = record(value, `secrets[${index}]`);
  exactKeys(item, ["name", "env", "required", "description"], `secrets[${index}]`);
  const name = boundedString(item["name"], `secrets[${index}].name`, 64);
  if (!SECRET_NAME.test(name)) throw new Error(`secrets[${index}].name has an invalid format`);
  const description = boundedString(item["description"], `secrets[${index}].description`, 200);
  const required = item["required"];
  if (typeof required !== "boolean") throw new Error(`secrets[${index}].required must be boolean`);
  const envValue = item["env"];
  if (envValue === undefined) return { name, required, description };
  const env = boundedString(envValue, `secrets[${index}].env`, 128);
  if (!ENV_NAME.test(env)) throw new Error(`secrets[${index}].env has an invalid format`);
  return { name, env, required, description };
}

/** Parse and fully validate a plugin manifest JSON document. */
export function parsePluginManifest(input: unknown): PluginManifest {
  if (typeof input === "string" && Buffer.byteLength(input, "utf8") > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error(`Plugin manifest exceeds ${MAX_PLUGIN_MANIFEST_BYTES} bytes`);
  }
  let decoded: unknown = input;
  if (typeof input === "string") {
    try {
      decoded = JSON.parse(input) as unknown;
    } catch {
      throw new Error("Plugin manifest is not valid JSON");
    }
  }
  const root = record(decoded, "plugin manifest");
  exactKeys(
    root,
    [
      "schemaVersion",
      "id",
      "name",
      "version",
      "hostApi",
      "artifact",
      "sha256",
      "hooks",
      "decisionProviders",
      "tools",
      "commands",
      "network",
      "dataSent",
      "secrets",
    ],
    "plugin manifest",
  );
  if (root["schemaVersion"] !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported plugin manifest schemaVersion: ${String(root["schemaVersion"])}`);
  }
  if (root["hostApi"] !== 1)
    throw new Error(`Unsupported plugin hostApi: ${String(root["hostApi"])}`);
  const id = boundedString(root["id"], "id", 128).toLowerCase();
  if (!PLUGIN_ID.test(id)) throw new Error("id must be a lowercase reverse-DNS-style identifier");
  const version = boundedString(root["version"], "version", 80);
  if (!VERSION.test(version)) throw new Error("version must be a semantic version");
  const sha256 = boundedString(root["sha256"], "sha256", 64);
  if (!SHA256.test(sha256)) throw new Error("sha256 must be exactly 64 lowercase hex characters");
  const network = record(root["network"], "network");
  exactKeys(network, ["destinations"], "network");
  const destinations = uniqueStrings(network["destinations"], "network.destinations", {
    maxItems: 16,
    maxLength: 255,
  }).map((destination, index) =>
    normalizeDestination(destination, `network.destinations[${index}]`),
  );
  if (new Set(destinations).size !== destinations.length) {
    throw new Error("network.destinations contains equivalent duplicates");
  }
  if (!Array.isArray(root["secrets"]) || root["secrets"].length > 16) {
    throw new Error("secrets must be an array with at most 16 entries");
  }
  const secrets = root["secrets"].map(parseSecret);
  if (new Set(secrets.map((secret) => secret.name)).size !== secrets.length) {
    throw new Error("secrets contains duplicate names");
  }
  return {
    schemaVersion: 1,
    id,
    name: boundedString(root["name"], "name", 100),
    version,
    hostApi: 1,
    artifact: boundedString(root["artifact"], "artifact", 2048),
    sha256,
    hooks: uniqueStrings(root["hooks"], "hooks", {
      maxItems: 8,
      maxLength: 64,
      pattern: HOOK_ID,
    }).map((hook) => {
      if (hook !== "route.skills") throw new Error(`Unknown advisory hook: ${hook}`);
      return hook;
    }),
    decisionProviders: uniqueStrings(root["decisionProviders"], "decisionProviders", {
      maxItems: 8,
      maxLength: 64,
      pattern: HOOK_ID,
    }),
    tools: parseTools(root["tools"]),
    commands: parseCommands(root["commands"]),
    network: { destinations: [...destinations].sort() },
    dataSent: [
      ...uniqueStrings(root["dataSent"], "dataSent", {
        maxItems: 16,
        maxLength: 200,
      }),
    ].sort(),
    secrets,
  };
}

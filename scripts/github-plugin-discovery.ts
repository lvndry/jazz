/**
 * Discovers opt-in community plugins from GitHub without downloading or executing their code.
 *
 * A repository participates by adding the `jazz-plugin` topic and a valid root `jazz-plugin.json`.
 * Discovery reads only GitHub metadata and that JSON manifest, then pins the result to the commit
 * currently at the repository's default branch. Community entries are metadata-only: the website
 * never turns them into executable artifacts or implies that Jazz reviewed their source.
 */

import { createHash } from "node:crypto";
import { MAX_PLUGIN_MANIFEST_BYTES, parsePluginSourceManifest } from "@jazz/adapters/plugins";
import type { PluginManifest } from "@jazz/adapters/plugins";

export const JAZZ_PLUGIN_TOPIC = "jazz-plugin";
const DEFAULT_GITHUB_API = "https://api.github.com";
const MAX_REPOSITORIES = 100;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

interface GitHubRepository {
  readonly id: number;
  readonly fullName: string;
  readonly htmlUrl: string;
  readonly defaultBranch: string;
  readonly description?: string;
  readonly license?: string;
  readonly archived: boolean;
  readonly fork: boolean;
}

interface GitHubResponse {
  readonly status: number;
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CommunityPluginEntry extends Omit<PluginManifest, "artifact" | "sha256"> {
  readonly sourceType: "community";
  readonly trustTier: "community-indexed";
  readonly repositoryId: number;
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly manifestUrl: string;
  readonly defaultBranch: string;
  readonly sourceSha: string;
  readonly manifestSha256: string;
  readonly manifestPath: "jazz-plugin.json";
  readonly indexedAt: string;
  readonly entry: string;
  readonly description?: string;
  readonly license?: string;
}

export interface GitHubPluginDiscoveryOptions {
  readonly apiUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRepositories?: number;
  readonly token?: string;
  readonly topic?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a string`);
  return value;
}

function booleanField(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function parseRepository(value: unknown, index: number): GitHubRepository {
  const item = record(value, `GitHub repository[${index}]`);
  const license =
    item["license"] === null ? undefined : record(item["license"], `repository[${index}].license`);
  return {
    id:
      typeof item["id"] === "number" && Number.isSafeInteger(item["id"]) && item["id"] > 0
        ? item["id"]
        : (() => {
            throw new Error(`repository[${index}].id must be a positive integer`);
          })(),
    fullName: stringField(item["full_name"], `repository[${index}].full_name`),
    htmlUrl: stringField(item["html_url"], `repository[${index}].html_url`),
    defaultBranch: stringField(item["default_branch"], `repository[${index}].default_branch`),
    ...(typeof item["description"] === "string" && item["description"].length > 0
      ? { description: item["description"] }
      : {}),
    ...(license !== undefined &&
    typeof license["spdx_id"] === "string" &&
    license["spdx_id"].length > 0
      ? { license: license["spdx_id"] }
      : {}),
    archived: booleanField(item["archived"], `repository[${index}].archived`),
    fork: booleanField(item["fork"], `repository[${index}].fork`),
  };
}

async function jsonResponse(response: GitHubResponse, url: string): Promise<unknown> {
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES)
    throw new Error(`GitHub response exceeds ${MAX_JSON_BYTES} bytes`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`GitHub returned invalid JSON for ${url}`);
  }
}

function headers(token: string | undefined): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "jazz-plugin-indexer",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  };
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<unknown> {
  const response = await fetchImpl(url, { headers: headers(token), redirect: "follow" });
  return jsonResponse(response, url);
}

function rawManifestUrl(repository: GitHubRepository, sourceSha: string): string {
  return `https://raw.githubusercontent.com/${repository.fullName}/${sourceSha}/jazz-plugin.json`;
}

function decodeContent(value: unknown, label: string): string {
  const content = record(value, label);
  if (content["type"] !== "file" || content["encoding"] !== "base64") {
    throw new Error(`${label} must be a base64-encoded file`);
  }
  return Buffer.from(stringField(content["content"], `${label}.content`), "base64").toString(
    "utf8",
  );
}

function communityEntry(
  repository: GitHubRepository,
  sourceSha: string,
  manifestText: string,
): CommunityPluginEntry {
  if (Buffer.byteLength(manifestText, "utf8") > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error(`jazz-plugin.json exceeds ${MAX_PLUGIN_MANIFEST_BYTES} bytes`);
  }
  const source = JSON.parse(manifestText) as unknown;
  const { manifest, entry } = parsePluginSourceManifest(source);
  const { artifact: _artifact, sha256: _sha256, ...metadata } = manifest;
  return {
    ...metadata,
    sourceType: "community",
    trustTier: "community-indexed",
    repositoryId: repository.id,
    repository: repository.fullName,
    repositoryUrl: repository.htmlUrl,
    manifestUrl: rawManifestUrl(repository, sourceSha),
    defaultBranch: repository.defaultBranch,
    sourceSha,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    manifestPath: "jazz-plugin.json",
    indexedAt: new Date().toISOString(),
    entry,
    ...(repository.description === undefined ? {} : { description: repository.description }),
    ...(repository.license === undefined ? {} : { license: repository.license }),
  };
}

async function discoverRepository(
  repository: GitHubRepository,
  apiUrl: string,
  fetchImpl: typeof fetch,
  token: string | undefined,
): Promise<CommunityPluginEntry> {
  const manifestUrl = `${apiUrl}/repos/${repository.fullName}/contents/jazz-plugin.json?ref=${encodeURIComponent(repository.defaultBranch)}`;
  const manifestResponse = await getJson(manifestUrl, fetchImpl, token);
  const manifestText = decodeContent(
    manifestResponse,
    `jazz-plugin.json for ${repository.fullName}`,
  );
  const commitUrl = `${apiUrl}/repos/${repository.fullName}/commits/${encodeURIComponent(repository.defaultBranch)}`;
  const commit = record(
    await getJson(commitUrl, fetchImpl, token),
    `commit for ${repository.fullName}`,
  );
  const sourceSha = stringField(commit["sha"], `commit for ${repository.fullName}.sha`);
  if (!/^[a-f0-9]{40}$/i.test(sourceSha)) {
    throw new Error(`commit for ${repository.fullName} has an invalid SHA`);
  }
  return communityEntry(repository, sourceSha.toLowerCase(), manifestText);
}

/** Discover valid, non-forked, non-archived GitHub repositories that opt into the Jazz topic. */
export async function discoverCommunityPlugins(
  options: GitHubPluginDiscoveryOptions = {},
): Promise<CommunityPluginEntry[]> {
  const apiUrl = options.apiUrl ?? DEFAULT_GITHUB_API;
  const fetchImpl = options.fetchImpl ?? fetch;
  const topic = options.topic ?? JAZZ_PLUGIN_TOPIC;
  const maxRepositories = Math.min(options.maxRepositories ?? MAX_REPOSITORIES, MAX_REPOSITORIES);
  const token = options.token ?? process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  const searchUrl = `${apiUrl}/search/repositories?q=${encodeURIComponent(
    `topic:${topic} archived:false fork:false`,
  )}&per_page=${maxRepositories}`;
  const search = record(await getJson(searchUrl, fetchImpl, token), "GitHub repository search");
  if (!Array.isArray(search["items"])) {
    throw new Error("GitHub repository search.items must be an array");
  }
  if (search["incomplete_results"] === true) {
    throw new Error("GitHub repository search was incomplete");
  }
  if (typeof search["total_count"] === "number" && search["total_count"] > maxRepositories) {
    throw new Error(
      `GitHub repository search exceeds the ${maxRepositories}-repository index limit`,
    );
  }

  const repositories = search["items"]
    .map((item, index) => parseRepository(item, index))
    .filter((repository) => !repository.archived && !repository.fork)
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  const discovered = await Promise.all(
    repositories.map(async (repository) => {
      try {
        return await discoverRepository(repository, apiUrl, fetchImpl, token);
      } catch (error) {
        process.stderr.write(
          `Skipping community plugin ${repository.fullName}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return undefined;
      }
    }),
  );

  const byId = new Map<string, CommunityPluginEntry>();
  for (const entry of discovered) {
    if (entry === undefined) continue;
    if (byId.has(entry.id)) {
      process.stderr.write(
        `Skipping duplicate community plugin id ${entry.id} from ${entry.repository}\n`,
      );
      continue;
    }
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

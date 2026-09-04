/**
 * Implements `PersonaRegistryService`: reads the persona marketplace, a static
 * catalog published alongside the Jazz website from `marketplace/personas/` in
 * the repository.
 *
 * The index is mirrored to `<jazz home>/cache/persona-registry.json` so browsing
 * keeps working offline, and every URL the index points at is checked against the
 * registry's own origin before it is fetched — a catalog is remote data, and it
 * must not be able to redirect an install at an arbitrary host.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import {
  PersonaRegistryServiceTag,
  type PersonaRegistryService,
} from "@jazz/core/interfaces/persona-registry";
import { NetworkError, ValidationError } from "@jazz/core/types/errors";
import type {
  PersonaRegistryIndex,
  RegistryPersonaDownload,
  RegistryPersonaEntry,
} from "@jazz/core/types/persona-registry";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import { isOfflineMode } from "@jazz/core/utils/runtime";
import { Effect, Layer, Option } from "effect";
import matter from "gray-matter";

/** Where the marketplace is published. Overridable for staging and for tests. */
const DEFAULT_REGISTRY_BASE_URL = "https://jazz-cli.vercel.app/marketplace";
const INDEX_PATH = "personas.json";
const DISK_CACHE_FILE = "persona-registry.json";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** Bounds on a downloaded definition, matching what `createPersona` will accept. */
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SYSTEM_PROMPT_LENGTH = 10_000;
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export interface PersonaRegistryServiceImplOptions {
  /** Override the registry base URL. Default: JAZZ_PERSONA_REGISTRY_URL, else the public site. */
  readonly baseUrl?: string;
  /** Override the directory the index snapshot is mirrored to. Default: `<jazz home>/cache`. */
  readonly cacheDir?: string;
}

/** Shape of the snapshot written to disk: the index plus when it was fetched. */
interface CachedIndex {
  readonly fetchedAt: number;
  readonly index: PersonaRegistryIndex;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseEntry(raw: unknown): RegistryPersonaEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const name = optionalString(record["name"]);
  const description = optionalString(record["description"]);
  const url = optionalString(record["url"]);
  if (name === undefined || description === undefined || url === undefined) return null;
  if (!VALID_NAME.test(name)) return null;

  const tone = optionalString(record["tone"]);
  const style = optionalString(record["style"]);
  const author = optionalString(record["author"]);
  const rawTags = record["tags"];
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
    : [];

  return {
    name,
    description,
    url,
    ...(tone !== undefined && { tone }),
    ...(style !== undefined && { style }),
    ...(author !== undefined && { author }),
    ...(tags.length > 0 && { tags }),
  };
}

/** Parse an index document, treating both malformed JSON and a bad shape as "no catalog". */
function parseIndexJson(raw: string): PersonaRegistryIndex | null {
  try {
    return parseIndex(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseIndex(raw: unknown): PersonaRegistryIndex | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const personas = record["personas"];
  if (!Array.isArray(personas)) return null;

  const parsed = personas
    .map(parseEntry)
    .filter((entry): entry is RegistryPersonaEntry => entry !== null);

  const version = typeof record["version"] === "number" ? record["version"] : 1;
  return { version, personas: parsed };
}

export class PersonaRegistryServiceImpl implements PersonaRegistryService {
  private readonly baseUrlOverride: string | undefined;
  private readonly cacheDirOverride: string | undefined;

  constructor(options?: PersonaRegistryServiceImplOptions) {
    this.baseUrlOverride = options?.baseUrl;
    this.cacheDirOverride = options?.cacheDir;
  }

  private baseUrl(): string {
    const fromEnv = process.env["JAZZ_PERSONA_REGISTRY_URL"];
    const raw =
      this.baseUrlOverride ??
      (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_REGISTRY_BASE_URL);
    return raw.endsWith("/") ? raw : `${raw}/`;
  }

  private cachePath(): string {
    return join(this.cacheDirOverride ?? join(getUserDataDirectory(), "cache"), DISK_CACHE_FILE);
  }

  /**
   * Resolve an entry URL against the registry base, refusing anything that leaves
   * the registry's origin. Without this, one bad index entry could point an install
   * at an attacker-controlled prompt on an unrelated host.
   */
  private resolveEntryUrl(url: string): string | null {
    const base = this.baseUrl();
    try {
      const resolved = new URL(url, base);
      const baseUrl = new URL(base);
      if (resolved.origin !== baseUrl.origin) return null;
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
      return resolved.toString();
    } catch {
      return null;
    }
  }

  private async readDiskCache(): Promise<CachedIndex | null> {
    try {
      const raw = await readFile(this.cachePath(), "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const index = parseIndex(parsed["index"]);
      if (index === null) return null;
      const fetchedAt = typeof parsed["fetchedAt"] === "number" ? parsed["fetchedAt"] : 0;
      return { fetchedAt, index };
    } catch {
      return null;
    }
  }

  private async writeDiskCache(index: PersonaRegistryIndex): Promise<void> {
    const path = this.cachePath();
    await mkdir(dirname(path), { recursive: true });
    const snapshot: CachedIndex = { fetchedAt: Date.now(), index };
    await writeFile(path, JSON.stringify(snapshot), "utf8");
  }

  private async fetchText(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: { Accept: "text/plain, application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  listEntries(options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<readonly RegistryPersonaEntry[], NetworkError> {
    return Effect.gen(
      function* (this: PersonaRegistryServiceImpl) {
        const indexUrl = new URL(INDEX_PATH, this.baseUrl()).toString();
        const refresh = options?.refresh === true;

        const cached = yield* Effect.promise(() => this.readDiskCache());
        const cacheIsFresh =
          cached !== null && !refresh && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
        if (cacheIsFresh) {
          return sortEntries(cached.index.personas);
        }

        if (isOfflineMode()) {
          if (cached !== null) return sortEntries(cached.index.personas);
          return yield* Effect.fail(
            new NetworkError({
              url: indexUrl,
              reason: "Jazz is running offline and no marketplace snapshot has been cached yet",
              suggestion:
                "Unset JAZZ_OFFLINE and run 'jazz persona browse' once to cache the catalog.",
            }),
          );
        }

        const fetched = yield* Effect.tryPromise({
          try: () => this.fetchText(indexUrl),
          catch: (error) => error,
        }).pipe(Effect.catchAll(() => Effect.succeed(null)));

        if (fetched === null) {
          if (cached !== null) {
            const logger = yield* Effect.serviceOption(LoggerServiceTag);
            if (Option.isSome(logger)) {
              yield* logger.value.warn(
                `Persona marketplace unreachable at ${indexUrl}; using the cached catalog.`,
              );
            }
            return sortEntries(cached.index.personas);
          }
          return yield* Effect.fail(
            new NetworkError({
              url: indexUrl,
              reason: "Could not reach the persona marketplace",
              suggestion:
                "Check your connection, or set JAZZ_PERSONA_REGISTRY_URL if you host your own catalog.",
            }),
          );
        }

        const index = parseIndexJson(fetched);

        if (index === null) {
          if (cached !== null) return sortEntries(cached.index.personas);
          return yield* Effect.fail(
            new NetworkError({
              url: indexUrl,
              reason: "The persona marketplace returned a catalog Jazz could not read",
              suggestion: "This is likely a temporary publishing problem — try again shortly.",
            }),
          );
        }

        const resolved = index;
        yield* Effect.tryPromise({
          try: () => this.writeDiskCache(resolved),
          catch: (error) => error,
        }).pipe(Effect.ignore);

        return sortEntries(resolved.personas);
      }.bind(this),
    );
  }

  fetchPersona(
    name: string,
  ): Effect.Effect<RegistryPersonaDownload, NetworkError | ValidationError> {
    return Effect.gen(
      function* (this: PersonaRegistryServiceImpl) {
        const entries = yield* this.listEntries();
        const entry = entries.find(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        );

        if (entry === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              field: "name",
              message: `No marketplace persona named "${name}"`,
              value: name,
              suggestion: "Run 'jazz persona browse' to see what the marketplace offers.",
            }),
          );
        }

        const sourceUrl = this.resolveEntryUrl(entry.url);
        if (sourceUrl === null) {
          return yield* Effect.fail(
            new ValidationError({
              field: "url",
              message: `Marketplace entry "${entry.name}" points outside the registry`,
              value: entry.url,
              suggestion:
                "Jazz refuses to install a persona hosted off the registry's own origin. Report this catalog entry.",
            }),
          );
        }

        const markdown = yield* Effect.tryPromise({
          try: () => this.fetchText(sourceUrl),
          catch: (error) =>
            new NetworkError({
              url: sourceUrl,
              reason: `Could not download persona "${entry.name}": ${
                error instanceof Error ? error.message : String(error)
              }`,
              suggestion: "Check your connection and try again.",
            }),
        });

        const parsed = matter(markdown);
        const data = parsed.data as Record<string, unknown>;
        const systemPrompt = parsed.content.trim();

        if (systemPrompt.length === 0) {
          return yield* Effect.fail(
            new ValidationError({
              field: "systemPrompt",
              message: `Marketplace persona "${entry.name}" has an empty system prompt`,
              value: sourceUrl,
              suggestion: "Report this catalog entry — it was published without a prompt body.",
            }),
          );
        }

        if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
          return yield* Effect.fail(
            new ValidationError({
              field: "systemPrompt",
              message: `Marketplace persona "${entry.name}" exceeds the ${MAX_SYSTEM_PROMPT_LENGTH}-character prompt limit`,
              value: `(${systemPrompt.length} chars)`,
              suggestion: "Report this catalog entry — Jazz will not install a prompt this large.",
            }),
          );
        }

        const description = (optionalString(data["description"]) ?? entry.description).slice(
          0,
          MAX_DESCRIPTION_LENGTH,
        );
        const tone = optionalString(data["tone"]) ?? entry.tone;
        const style = optionalString(data["style"]) ?? entry.style;

        return {
          entry,
          sourceUrl,
          description,
          systemPrompt,
          ...(tone !== undefined && { tone }),
          ...(style !== undefined && { style }),
        };
      }.bind(this),
    );
  }
}

function sortEntries(entries: readonly RegistryPersonaEntry[]): readonly RegistryPersonaEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

// ─── Layer ───────────────────────────────────────────────────────────────────

export function createPersonaRegistryServiceLayer(): Layer.Layer<PersonaRegistryService> {
  return Layer.succeed(PersonaRegistryServiceTag, new PersonaRegistryServiceImpl());
}

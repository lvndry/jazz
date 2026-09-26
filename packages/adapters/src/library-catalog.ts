/**
 * The machinery shared by the persona and workflow libraries: one static
 * catalog published from the Jazz website, read through a JSON index and one
 * raw markdown file per entry.
 *
 * `LibraryCatalog` owns everything that is the same for every kind of entry:
 * where the library lives, the disk snapshot that keeps browsing working
 * offline (`<jazz home>/cache/<cacheFile>`), and the origin check every entry URL
 * must pass before it is fetched — a catalog is remote data, and it must not be
 * able to redirect an install at an arbitrary host. Each registry service wraps a
 * catalog, tells it how to read one index record, and validates the downloaded
 * markdown with its own rules.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LoggerServiceTag } from "@jazz/core/interfaces/logger";
import { NetworkError, ValidationError } from "@jazz/core/types/errors";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import { isOfflineMode } from "@jazz/core/utils/runtime";
import { toError } from "@jazz/core/utils/storage";
import { Effect, Option } from "effect";

/** Where the library is published. Overridable with JAZZ_LIBRARY_URL, for staging and tests. */
const DEFAULT_LIBRARY_URL = "https://jazz-cli.vercel.app/library";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

/** The fields every library entry carries, whatever its kind. */
export interface LibraryEntry {
  /** Catalog name, unique within its collection. Also the default install name. */
  readonly name: string;
  /** Brief human-readable summary. */
  readonly description: string;
  /** Who contributed the entry. */
  readonly author?: string;
  /** Free-form tags used for search and filtering. */
  readonly tags?: readonly string[];
  /** Location of the raw markdown, absolute or relative to the library base URL. */
  readonly url: string;
}

/** One entry's markdown, downloaded and ready for kind-specific validation. */
export interface LibraryDownload<TEntry extends LibraryEntry> {
  readonly entry: TEntry;
  readonly sourceUrl: string;
  readonly markdown: string;
}

export interface LibraryCatalogOptions<TEntry extends LibraryEntry> {
  /** What one entry is called in messages, e.g. "persona". */
  readonly kind: string;
  /** Key of the entry array in the index document; also names the index file `<collection>.json`. */
  readonly collection: string;
  /** File name of the disk snapshot under the cache directory. */
  readonly cacheFile: string;
  /** Command that lists the catalog, offered in error suggestions. */
  readonly browseCommand: string;
  /** Add kind-specific fields to an entry whose shared fields already validated. */
  readonly parseEntry: (record: Record<string, unknown>, base: LibraryEntry) => TEntry;
  /** Override the library base URL. Default: JAZZ_LIBRARY_URL, else the public site. */
  readonly baseUrl?: string | undefined;
  /** Override the directory the index snapshot is mirrored to. Default: `<jazz home>/cache`. */
  readonly cacheDir?: string | undefined;
}

/** Shape of the snapshot written to disk: the entries plus when they were fetched. */
interface CachedIndex<TEntry> {
  readonly fetchedAt: number;
  readonly entries: readonly TEntry[];
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseBaseEntry(raw: unknown): LibraryEntry | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const name = optionalString(record["name"]);
  const description = optionalString(record["description"]);
  const url = optionalString(record["url"]);
  if (name === undefined || description === undefined || url === undefined) return null;
  if (!VALID_NAME.test(name)) return null;

  const author = optionalString(record["author"]);
  const rawTags = record["tags"];
  const tags = Array.isArray(rawTags)
    ? rawTags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
    : [];

  return {
    name,
    description,
    url,
    ...(author !== undefined && { author }),
    ...(tags.length > 0 && { tags }),
  };
}

function sortEntries<TEntry extends LibraryEntry>(entries: readonly TEntry[]): readonly TEntry[] {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}

export class LibraryCatalog<TEntry extends LibraryEntry> {
  constructor(private readonly options: LibraryCatalogOptions<TEntry>) {}

  private baseUrl(): string {
    const fromEnv = process.env["JAZZ_LIBRARY_URL"];
    const raw =
      this.options.baseUrl ??
      (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_LIBRARY_URL);
    return raw.endsWith("/") ? raw : `${raw}/`;
  }

  private indexUrl(): string {
    return new URL(`${this.options.collection}.json`, this.baseUrl()).toString();
  }

  private cachePath(): string {
    return join(
      this.options.cacheDir ?? join(getUserDataDirectory(), "cache"),
      this.options.cacheFile,
    );
  }

  /** Parse an index document, treating both malformed JSON and a bad shape as "no catalog". */
  private parseIndex(raw: unknown): readonly TEntry[] | null {
    if (raw === null || typeof raw !== "object") return null;
    const collection = (raw as Record<string, unknown>)[this.options.collection];
    if (!Array.isArray(collection)) return null;

    const entries: TEntry[] = [];
    for (const item of collection) {
      const base = parseBaseEntry(item);
      if (base !== null)
        entries.push(this.options.parseEntry(item as Record<string, unknown>, base));
    }
    return entries;
  }

  private parseIndexJson(raw: string): readonly TEntry[] | null {
    try {
      return this.parseIndex(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /**
   * Resolve an entry URL against the library base, refusing anything that
   * leaves its origin. Without this, one bad index entry could point an install
   * at an attacker-controlled file on an unrelated host.
   */
  private resolveEntryUrl(url: string): string | null {
    const base = this.baseUrl();
    try {
      const resolved = new URL(url, base);
      if (resolved.origin !== new URL(base).origin) return null;
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
      return resolved.toString();
    } catch {
      return null;
    }
  }

  private async readDiskCache(): Promise<CachedIndex<TEntry> | null> {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath(), "utf8")) as Record<
        string,
        unknown
      >;
      const entries = this.parseIndex({ [this.options.collection]: parsed["entries"] });
      if (entries === null) return null;
      const fetchedAt = typeof parsed["fetchedAt"] === "number" ? parsed["fetchedAt"] : 0;
      return { fetchedAt, entries };
    } catch {
      return null;
    }
  }

  private async writeDiskCache(entries: readonly TEntry[]): Promise<void> {
    const path = this.cachePath();
    await mkdir(dirname(path), { recursive: true });
    const snapshot: CachedIndex<TEntry> = { fetchedAt: Date.now(), entries };
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

  /**
   * List every entry the library advertises, sorted by name. Served from the
   * disk snapshot while fresh; falls back to it when the network is unreachable
   * or Jazz runs offline.
   */
  listEntries(options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<readonly TEntry[], NetworkError> {
    return Effect.gen(
      function* (this: LibraryCatalog<TEntry>) {
        const { kind, browseCommand } = this.options;
        const indexUrl = this.indexUrl();
        const refresh = options?.refresh === true;

        const cached = yield* Effect.promise(() => this.readDiskCache());
        const cacheIsFresh =
          cached !== null && !refresh && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
        if (cacheIsFresh) {
          return sortEntries(cached.entries);
        }

        if (isOfflineMode()) {
          if (cached !== null) return sortEntries(cached.entries);
          return yield* Effect.fail(
            new NetworkError({
              url: indexUrl,
              reason: "Jazz is running offline and no library snapshot has been cached yet",
              suggestion: `Unset JAZZ_OFFLINE and run '${browseCommand}' once to cache the catalog.`,
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
                `${kind} library unreachable at ${indexUrl}; using the cached catalog.`,
              );
            }
            return sortEntries(cached.entries);
          }
          return yield* Effect.fail(
            new NetworkError({
              url: indexUrl,
              reason: `Could not reach the ${kind} library`,
              suggestion:
                "Check your connection, or set JAZZ_LIBRARY_URL if you host your own catalog.",
            }),
          );
        }

        const entries = this.parseIndexJson(fetched);

        if (entries === null) {
          if (cached !== null) return sortEntries(cached.entries);
          return yield* Effect.fail(
            new NetworkError({
              url: indexUrl,
              reason: `The ${kind} library returned a catalog Jazz could not read`,
              suggestion: "This is likely a temporary publishing problem — try again shortly.",
            }),
          );
        }

        yield* Effect.tryPromise({
          try: () => this.writeDiskCache(entries),
          catch: (error) => error,
        }).pipe(Effect.ignore);

        return sortEntries(entries);
      }.bind(this),
    );
  }

  /**
   * Find one entry by name (case-insensitive) and download its markdown from the
   * library's own origin. Validating the markdown is the caller's job.
   */
  fetchEntry(name: string): Effect.Effect<LibraryDownload<TEntry>, NetworkError | ValidationError> {
    return Effect.gen(
      function* (this: LibraryCatalog<TEntry>) {
        const { kind, browseCommand } = this.options;
        const entries = yield* this.listEntries();
        const entry = entries.find(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        );

        if (entry === undefined) {
          return yield* Effect.fail(
            new ValidationError({
              field: "name",
              message: `No library ${kind} named "${name}"`,
              value: name,
              suggestion: `Run '${browseCommand}' to see what the library offers.`,
            }),
          );
        }

        const sourceUrl = this.resolveEntryUrl(entry.url);
        if (sourceUrl === null) {
          return yield* Effect.fail(
            new ValidationError({
              field: "url",
              message: `Library entry "${entry.name}" points outside the registry`,
              value: entry.url,
              suggestion: `Jazz refuses to install a ${kind} hosted off the library's own origin. Report this catalog entry.`,
            }),
          );
        }

        const markdown = yield* Effect.tryPromise({
          try: () => this.fetchText(sourceUrl),
          catch: (error) =>
            new NetworkError({
              url: sourceUrl,
              reason: `Could not download ${kind} "${entry.name}": ${toError(error).message}`,
              suggestion: "Check your connection and try again.",
            }),
        });

        return { entry, sourceUrl, markdown };
      }.bind(this),
    );
  }
}

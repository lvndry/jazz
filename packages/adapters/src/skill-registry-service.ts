/**
 * Implements `SkillRegistryService` for the reviewed Jazz skill marketplace.
 *
 * `LibraryCatalog` provides the shared catalog fetch, origin check, disk cache,
 * and offline fallback. This adapter adds skill metadata parsing and enforces
 * the first marketplace boundary: one origin-hosted `SKILL.md`, with no bundle,
 * script, binary, or auxiliary-file manifest.
 */

import {
  SkillRegistryServiceTag,
  type SkillRegistryService,
} from "@jazz/core/interfaces/skill-registry";
import { NetworkError, ValidationError } from "@jazz/core/types/errors";
import type {
  RegistrySkillDownload,
  RegistrySkillEntry,
  RegistrySkillMetadata,
} from "@jazz/core/types/skill-registry";
import { Effect, Layer } from "effect";
import matter from "gray-matter";
import { LibraryCatalog, optionalString } from "./library-catalog";

/** A catalog entry must remain a small, instruction-only artifact. */
const MAX_SKILL_LENGTH = 100_000;

/** Frontmatter keys that would describe a multi-file or executable skill. */
const DISALLOWED_ARTIFACT_FIELDS = new Set([
  "artifact",
  "binaries",
  "bundle",
  "dependencies",
  "entrypoint",
  "files",
  "references",
  "script",
  "scripts",
]);

export interface SkillRegistryServiceImplOptions {
  /** Override the library base URL. Default: JAZZ_LIBRARY_URL, else the public site. */
  readonly baseUrl?: string;
  /** Override the directory the index snapshot is mirrored to. Default: `<jazz home>/cache`. */
  readonly cacheDir?: string;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return values.length > 0 ? values.map((item) => item.trim()) : undefined;
}

function parseSkillEntry(
  record: Record<string, unknown>,
  base: RegistrySkillEntry,
): RegistrySkillEntry {
  const author = optionalString(record["author"]);
  const tags = stringArray(record["tags"]);
  const version = optionalString(record["version"]);
  const compatibility = optionalString(record["compatibility"]);
  const license = optionalString(record["license"]);

  return {
    ...base,
    ...(author !== undefined && { author }),
    ...(tags !== undefined && { tags }),
    ...(version !== undefined && { version }),
    ...(compatibility !== undefined && { compatibility }),
    ...(license !== undefined && { license }),
  };
}

function isSingleSkillDocumentUrl(sourceUrl: string): boolean {
  try {
    const pathname = new URL(sourceUrl).pathname;
    const fileName = pathname.slice(pathname.lastIndexOf("/") + 1);
    // The website exposes repository skills as /<name>.md while self-hosted
    // catalogs may retain the source filename /SKILL.md. Both are still one
    // Markdown document; bundles, archives, and executable artifacts are not.
    return /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(fileName);
  } catch {
    return false;
  }
}

/**
 * Parse and validate the metadata in a downloaded `SKILL.md`.
 *
 * The function is exported so the adapter tests can pin the instruction-only
 * boundary without needing a network. Unknown frontmatter is tolerated for
 * future display metadata, while fields that imply extra files or execution
 * are rejected explicitly.
 */
export function parseRegistrySkillMetadata(
  markdown: string,
  expectedName: string,
): RegistrySkillMetadata | null {
  try {
    const parsed = matter(markdown);
    const data = parsed.data as Record<string, unknown>;
    const name = optionalString(data["name"]);
    const description = optionalString(data["description"]);

    if (
      name === undefined ||
      description === undefined ||
      name.toLowerCase() !== expectedName.toLowerCase()
    ) {
      return null;
    }

    for (const key of Object.keys(data)) {
      if (DISALLOWED_ARTIFACT_FIELDS.has(key.toLowerCase())) return null;
    }

    const author = optionalString(data["author"]);
    const tags = stringArray(data["tags"]);
    const version = optionalString(data["version"]);
    const compatibility = optionalString(data["compatibility"]);
    const license = optionalString(data["license"]);

    return {
      name,
      description,
      ...(author !== undefined && { author }),
      ...(tags !== undefined && { tags }),
      ...(version !== undefined && { version }),
      ...(compatibility !== undefined && { compatibility }),
      ...(license !== undefined && { license }),
    };
  } catch {
    return null;
  }
}

export class SkillRegistryServiceImpl implements SkillRegistryService {
  private readonly catalog: LibraryCatalog<RegistrySkillEntry>;

  constructor(options?: SkillRegistryServiceImplOptions) {
    this.catalog = new LibraryCatalog<RegistrySkillEntry>({
      kind: "skill",
      collection: "skills",
      cacheFile: "skill-registry.json",
      browseCommand: "jazz skill browse",
      parseEntry: parseSkillEntry,
      baseUrl: options?.baseUrl,
      cacheDir: options?.cacheDir,
    });
  }

  listEntries(options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<readonly RegistrySkillEntry[], NetworkError> {
    return this.catalog.listEntries(options);
  }

  fetchSkill(name: string): Effect.Effect<RegistrySkillDownload, NetworkError | ValidationError> {
    return Effect.gen(
      function* (this: SkillRegistryServiceImpl) {
        const download = yield* this.catalog.fetchEntry(name);

        if (!isSingleSkillDocumentUrl(download.sourceUrl)) {
          return yield* Effect.fail(
            new ValidationError({
              field: "url",
              message: `Library skill "${download.entry.name}" is not a single SKILL.md document`,
              value: download.sourceUrl,
              suggestion:
                "Jazz installs one instruction file only; report catalog entries that point to bundles or executable artifacts.",
            }),
          );
        }

        if (download.markdown.length > MAX_SKILL_LENGTH) {
          return yield* Effect.fail(
            new ValidationError({
              field: "markdown",
              message: `Library skill "${download.entry.name}" exceeds the ${MAX_SKILL_LENGTH}-character limit`,
              value: `(${download.markdown.length} chars)`,
              suggestion: "Report this catalog entry — Jazz will not install an oversized skill.",
            }),
          );
        }

        const metadata = parseRegistrySkillMetadata(download.markdown, download.entry.name);
        if (metadata === null) {
          return yield* Effect.fail(
            new ValidationError({
              field: "frontmatter",
              message: `Library skill "${download.entry.name}" has invalid SKILL.md frontmatter`,
              value: download.sourceUrl,
              suggestion:
                "The file must declare matching name and description metadata and contain no bundle or executable fields.",
            }),
          );
        }

        return { ...download, metadata };
      }.bind(this),
    );
  }
}

// ─── Layer ───────────────────────────────────────────────────────────────────

export function createSkillRegistryServiceLayer(): Layer.Layer<SkillRegistryService> {
  return Layer.succeed(SkillRegistryServiceTag, new SkillRegistryServiceImpl());
}

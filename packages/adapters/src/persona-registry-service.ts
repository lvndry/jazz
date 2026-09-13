/**
 * Implements `PersonaRegistryService`: the persona half of the library.
 *
 * Fetching, caching, and the origin check live in `LibraryCatalog`; this
 * module adds what makes an entry a persona (tone and style in the index) and
 * checks a downloaded `PERSONA.md` against the bounds `createPersona` enforces,
 * so an install can never produce a persona Jazz would refuse to create by hand.
 */

import {
  PersonaRegistryServiceTag,
  type PersonaRegistryService,
} from "@jazz/core/interfaces/persona-registry";
import { NetworkError, ValidationError } from "@jazz/core/types/errors";
import type {
  RegistryPersonaDownload,
  RegistryPersonaEntry,
} from "@jazz/core/types/persona-registry";
import { Effect, Layer } from "effect";
import matter from "gray-matter";
import { LibraryCatalog, optionalString } from "./library-catalog";

/** Bounds on a downloaded definition, matching what `createPersona` will accept. */
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_SYSTEM_PROMPT_LENGTH = 10_000;

export interface PersonaRegistryServiceImplOptions {
  /** Override the library base URL. Default: JAZZ_LIBRARY_URL, else the public site. */
  readonly baseUrl?: string;
  /** Override the directory the index snapshot is mirrored to. Default: `<jazz home>/cache`. */
  readonly cacheDir?: string;
}

export class PersonaRegistryServiceImpl implements PersonaRegistryService {
  private readonly catalog: LibraryCatalog<RegistryPersonaEntry>;

  constructor(options?: PersonaRegistryServiceImplOptions) {
    this.catalog = new LibraryCatalog<RegistryPersonaEntry>({
      kind: "persona",
      collection: "personas",
      cacheFile: "persona-registry.json",
      browseCommand: "jazz persona browse",
      parseEntry: (record, base) => {
        const tone = optionalString(record["tone"]);
        const style = optionalString(record["style"]);
        return {
          ...base,
          ...(tone !== undefined && { tone }),
          ...(style !== undefined && { style }),
        };
      },
      baseUrl: options?.baseUrl,
      cacheDir: options?.cacheDir,
    });
  }

  listEntries(options?: {
    readonly refresh?: boolean;
  }): Effect.Effect<readonly RegistryPersonaEntry[], NetworkError> {
    return this.catalog.listEntries(options);
  }

  fetchPersona(
    name: string,
  ): Effect.Effect<RegistryPersonaDownload, NetworkError | ValidationError> {
    return Effect.gen(
      function* (this: PersonaRegistryServiceImpl) {
        const { entry, sourceUrl, markdown } = yield* this.catalog.fetchEntry(name);

        const parsed = matter(markdown);
        const data = parsed.data as Record<string, unknown>;
        const systemPrompt = parsed.content.trim();

        if (systemPrompt.length === 0) {
          return yield* Effect.fail(
            new ValidationError({
              field: "systemPrompt",
              message: `Library persona "${entry.name}" has an empty system prompt`,
              value: sourceUrl,
              suggestion: "Report this catalog entry — it was published without a prompt body.",
            }),
          );
        }

        if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
          return yield* Effect.fail(
            new ValidationError({
              field: "systemPrompt",
              message: `Library persona "${entry.name}" exceeds the ${MAX_SYSTEM_PROMPT_LENGTH}-character prompt limit`,
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

// ─── Layer ───────────────────────────────────────────────────────────────────

export function createPersonaRegistryServiceLayer(): Layer.Layer<PersonaRegistryService> {
  return Layer.succeed(PersonaRegistryServiceTag, new PersonaRegistryServiceImpl());
}

/**
 * `PersonaRegistryService` interface for reading the persona marketplace — a
 * remote, git-backed catalog of shareable personas that users can install into
 * `~/.jazz/personas/`.
 */
import { Context, Effect } from "effect";
import type { NetworkError, ValidationError } from "@/core/types/errors";
import type { RegistryPersonaDownload, RegistryPersonaEntry } from "@/core/types/persona-registry";

export interface PersonaRegistryService {
  /**
   * List every persona advertised by the marketplace.
   *
   * Served from a disk snapshot while it is fresh, and falls back to the last
   * snapshot when the network is unreachable or Jazz is running offline.
   *
   * @param options.refresh - Bypass the cached snapshot and re-fetch the index
   * @returns An Effect resolving to the catalog entries, sorted by name
   */
  readonly listEntries: (options?: {
    readonly refresh?: boolean;
  }) => Effect.Effect<readonly RegistryPersonaEntry[], NetworkError>;

  /**
   * Download one persona's full definition, including its system prompt.
   *
   * @param name - Catalog name of the persona to download
   * @returns An Effect resolving to the downloaded persona
   */
  readonly fetchPersona: (
    name: string,
  ) => Effect.Effect<RegistryPersonaDownload, NetworkError | ValidationError>;
}

export const PersonaRegistryServiceTag =
  Context.GenericTag<PersonaRegistryService>("PersonaRegistryService");

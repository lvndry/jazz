/**
 * @fileoverview Persona marketplace domain model types
 *
 * The marketplace is a git-backed catalog of shareable personas: each entry is a
 * `persona.md` under `marketplace/personas/<name>/` in the Jazz repository, published
 * as a static index plus one raw markdown file per persona. Nothing here is
 * user-generated at runtime — entries land in the catalog through a pull request.
 */

/** One persona as advertised by the marketplace index (metadata only, no prompt). */
export interface RegistryPersonaEntry {
  /** Catalog name, unique within the registry. Also the default install name. */
  readonly name: string;
  /** Brief human-readable summary of what this persona does. */
  readonly description: string;
  /** Optional tone descriptor (e.g. "patient", "skeptical"). */
  readonly tone?: string;
  /** Optional style descriptor (e.g. "concise", "probing"). */
  readonly style?: string;
  /** Who contributed the persona. */
  readonly author?: string;
  /** Free-form tags used for search and filtering. */
  readonly tags?: readonly string[];
  /**
   * Location of the raw `persona.md`, absolute or relative to the registry base URL.
   * Resolved against the base and rejected if it escapes that origin.
   */
  readonly url: string;
}

/** The marketplace index document served at `<registry base>/personas.json`. */
export interface PersonaRegistryIndex {
  /** Index schema version. Bumped when the entry shape changes incompatibly. */
  readonly version: number;
  readonly personas: readonly RegistryPersonaEntry[];
}

/**
 * A persona downloaded from the marketplace: the catalog entry it came from, the
 * fields ready to hand to `PersonaService.createPersona`, and the URL it was read
 * from so the CLI can show the user exactly what they are about to trust.
 */
export interface RegistryPersonaDownload {
  readonly entry: RegistryPersonaEntry;
  readonly sourceUrl: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tone?: string;
  readonly style?: string;
}

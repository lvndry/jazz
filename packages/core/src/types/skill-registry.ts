/**
 * @fileoverview Domain types for the reviewed Jazz skill catalog.
 *
 * Marketplace skills are intentionally represented as one `SKILL.md` file:
 * the catalog carries discovery metadata, while the downloaded markdown is
 * installed byte-for-byte as an instruction artifact. No executable payload
 * or additional file is part of this first registry contract.
 */

/** One skill as advertised by the marketplace index, without its instructions. */
export interface RegistrySkillEntry {
  /** Catalog name, unique within the registry and safe as a directory name. */
  readonly name: string;
  /** Brief human-readable summary of the procedure the skill teaches. */
  readonly description: string;
  /** Optional contributor or publisher name. */
  readonly author?: string;
  /** Free-form discovery tags. */
  readonly tags?: readonly string[];
  /** Optional published skill version. */
  readonly version?: string;
  /** Optional compatibility note shown before installation. */
  readonly compatibility?: string;
  /** Optional license identifier or notice. */
  readonly license?: string;
  /** Location of the raw `SKILL.md`, resolved and origin-checked by the adapter. */
  readonly url: string;
}

/** The marketplace index document served at `<registry base>/skills.json`. */
export interface SkillRegistryIndex {
  /** Index schema version. */
  readonly version: number;
  readonly skills: readonly RegistrySkillEntry[];
}

/** Metadata parsed from the downloaded skill's YAML frontmatter. */
export interface RegistrySkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly author?: string;
  readonly tags?: readonly string[];
  readonly version?: string;
  readonly compatibility?: string;
  readonly license?: string;
}

/** A validated, single-file skill downloaded from the reviewed catalog. */
export interface RegistrySkillDownload {
  readonly entry: RegistrySkillEntry;
  /** The origin-checked URL the bytes were fetched from. */
  readonly sourceUrl: string;
  /** The published `SKILL.md`, preserved exactly for installation. */
  readonly markdown: string;
  /** Validated metadata parsed from the file's frontmatter. */
  readonly metadata: RegistrySkillMetadata;
}

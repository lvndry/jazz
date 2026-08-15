/**
 * Manifest of the asset files embedded in a standalone binary.
 *
 * Jazz ships `personas/`, `skills/`, and `workflows/` as real directories, and
 * every loader that reads them walks the filesystem. That works for the npm
 * package, where `getPackageRootDirectory()` finds the package by walking up
 * from `dist/main.js`. A standalone binary has no package directory at all, so
 * `scripts/build.ts` generates a replacement for this module that imports each
 * asset with `{ type: "file" }`, and points the bundler at the generated file.
 *
 * This checked-in version is the one the npm build and development mode use,
 * and it is deliberately empty: both already have the real directories on disk.
 */

export interface EmbeddedAssetFile {
  /** Path relative to the package root, e.g. `skills/journal/SKILL.md`. */
  readonly relativePath: string;
  /** Path the embedded copy is readable from at runtime. */
  readonly sourcePath: string;
  /** Whether the extracted copy needs the executable bit. */
  readonly executable: boolean;
}

export const EMBEDDED_ASSET_FILES: readonly EmbeddedAssetFile[] = [];

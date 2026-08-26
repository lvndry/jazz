/**
 * Manifest of the asset files embedded in a standalone binary.
 *
 * Jazz ships `personas/`, `skills/`, and `workflows/` as real directories, and
 * every loader that reads them walks the filesystem. That works in
 * development, where `getPackageRootDirectory()` finds the repo root by
 * walking up from this file to a `package.json` named `jazz-ai`. Every
 * published binary — the curl-installed standalone binary and the npm
 * `jazz-ai-<platform>` package alike — has no such directory on disk at all,
 * so `scripts/build.ts` generates a replacement for this module that imports
 * each asset with `{ type: "file" }`, and points the bundler at the generated
 * file.
 *
 * This checked-in version is the one development mode uses, and it is
 * deliberately empty: it already has the real directories on disk.
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

/**
 * Acquires plugin manifests and executable artifacts without executing them.
 *
 * Remote downloads are HTTPS-only, same-origin across redirects, byte-bounded,
 * and time-bounded. Local artifacts must be regular, non-symlink files contained
 * by the manifest directory. A packed module may import only runtime built-ins,
 * because its digest covers that one file. Verified modules are installed in
 * digest-addressed directories through a sibling partial directory + rename.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toError } from "@jazz/core/utils/errors";
import { fetchWithinOrigins } from "./bounded-fetch";
import { copySourceTree } from "./github-source";
import {
  MAX_PLUGIN_ARTIFACT_BYTES,
  MAX_PLUGIN_MANIFEST_BYTES,
  parsePluginManifest,
  parsePluginSourceEntry,
  type PluginManifest,
} from "./manifest-schema";
import { isPathWithin, scanPluginImportGraph } from "./source-integrity";

/** The single module file inside a packed plugin's digest-addressed directory. */
const PACKED_ARTIFACT_NAME = "plugin.mjs";
/** Redirect hops a manifest or artifact download may take, all on the manifest's origin. */
const MAX_REDIRECTS = 3;
/** Deadline for one manifest or artifact download, redirects and body included. */
const DOWNLOAD_TIMEOUT_MS = 15_000;

export interface AcquiredManifest {
  readonly manifest: PluginManifest;
  readonly source: URL;
}

async function fetchSameOrigin(
  source: URL,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<{ readonly bytes: Uint8Array; readonly finalUrl: URL }> {
  if (source.protocol !== "https:") {
    throw new Error("Remote plugin sources must use HTTPS");
  }
  const response = await fetchWithinOrigins(source, {
    allowedOrigins: new Set([source.origin]),
    limitBytes: limit,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    headers: { Accept: "application/json, text/javascript" },
    fetchImpl,
  });
  if (response.status < 200 || response.status > 299) {
    throw new Error(`Plugin download failed with HTTP ${response.status}`);
  }
  return { bytes: response.bytes, finalUrl: response.finalUrl };
}

async function readRegularFile(filePath: string, limit: number): Promise<Uint8Array> {
  const linkStat = await fs.lstat(filePath);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error(`Plugin source is not a regular non-symlink file: ${filePath}`);
  }
  if (linkStat.size > limit) throw new Error(`Plugin source exceeds ${limit} bytes`);
  return new Uint8Array(await fs.readFile(filePath));
}

export async function acquirePluginManifest(
  source: string | URL,
  fetchImpl: typeof fetch = fetch,
): Promise<AcquiredManifest> {
  const url =
    source instanceof URL
      ? source
      : /^[a-z]+:/i.test(source)
        ? new URL(source)
        : pathToFileURL(path.resolve(source));
  let bytes: Uint8Array;
  let finalUrl = url;
  if (url.protocol === "file:") {
    bytes = await readRegularFile(fileURLToPath(url), MAX_PLUGIN_MANIFEST_BYTES);
  } else {
    const remote = await fetchSameOrigin(url, MAX_PLUGIN_MANIFEST_BYTES, fetchImpl);
    bytes = remote.bytes;
    finalUrl = remote.finalUrl;
  }
  return { manifest: parsePluginManifest(new TextDecoder().decode(bytes)), source: finalUrl };
}

export interface ArtifactInstallerOptions {
  readonly pluginDirectory: string;
  readonly fetchImpl?: typeof fetch;
}

export class PluginArtifactInstaller {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ArtifactInstallerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  artifactPath(digest: string): string {
    return path.join(this.options.pluginDirectory, "artifacts", digest, PACKED_ARTIFACT_NAME);
  }

  /** The digest-addressed root of an installed source tree. */
  sourcePath(digest: string): string {
    return path.join(this.options.pluginDirectory, "sources", digest);
  }

  /**
   * The import entry inside an installed source tree. Throws unless `entry` is a safe relative path,
   * so the result always lies under the digest-addressed root.
   */
  sourceEntryPath(digest: string, entry: string): string {
    return path.join(this.sourcePath(digest), parsePluginSourceEntry(entry));
  }

  /**
   * Copy an extracted source tree into its digest-addressed home with the same rules the hash uses
   * (`node_modules`/`.git` skipped, symlinks and special files refused), so the on-disk tree matches
   * what was hashed. Idempotent: an existing tree at this digest is reused. The copy never
   * overwrites a different tree, because the directory name is the tree's own hash.
   */
  async commitSourceTree(sourceRoot: string, digest: string): Promise<string> {
    const finalDirectory = this.sourcePath(digest);
    try {
      await fs.access(finalDirectory);
      return finalDirectory;
    } catch {
      // Not yet installed; fall through to copy it in.
    }
    const parent = path.dirname(finalDirectory);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const partial = path.join(parent, `.${digest}.partial-${process.pid}-${Date.now()}`);
    try {
      await fs.mkdir(partial, { mode: 0o700 });
      await copySourceTree(sourceRoot, partial);
      try {
        await fs.rename(partial, finalDirectory);
      } catch (error) {
        // A concurrent installer may have won the race for this same digest.
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return finalDirectory;
        throw error;
      }
      return finalDirectory;
    } finally {
      await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async removeSource(digest: string): Promise<void> {
    await fs.rm(this.sourcePath(digest), { recursive: true, force: true });
  }

  async install(manifest: PluginManifest, manifestSource: URL): Promise<string> {
    const bytes = await this.acquireArtifact(manifest, manifestSource);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== manifest.sha256)
      throw new Error("Plugin artifact SHA-256 does not match manifest");

    const finalDirectory = path.dirname(this.artifactPath(actual));
    try {
      const existing = await readRegularFile(this.artifactPath(actual), MAX_PLUGIN_ARTIFACT_BYTES);
      if (createHash("sha256").update(existing).digest("hex") !== actual) {
        throw new Error("Existing digest-addressed plugin artifact was modified");
      }
      await scanPluginImportGraph(finalDirectory, PACKED_ARTIFACT_NAME);
      return this.artifactPath(actual);
    } catch (error) {
      if (
        error instanceof Error &&
        !error.message.includes("ENOENT") &&
        !error.message.includes("no such file")
      ) {
        throw error;
      }
    }

    const artifactsDirectory = path.dirname(finalDirectory);
    await fs.mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
    const partialDirectory = path.join(
      artifactsDirectory,
      `.${actual}.partial-${process.pid}-${Date.now()}`,
    );
    await fs.mkdir(partialDirectory, { mode: 0o700 });
    try {
      const partialFile = path.join(partialDirectory, PACKED_ARTIFACT_NAME);
      await fs.writeFile(partialFile, bytes, { mode: 0o600, flag: "wx" });
      await scanPluginImportGraph(partialDirectory, PACKED_ARTIFACT_NAME);
      await fs.rename(partialDirectory, finalDirectory).catch(async (error: unknown) => {
        try {
          const existing = await readRegularFile(
            this.artifactPath(actual),
            MAX_PLUGIN_ARTIFACT_BYTES,
          );
          if (createHash("sha256").update(existing).digest("hex") === actual) return;
        } catch {
          // Preserve the original rename failure below.
        }
        throw error;
      });
    } finally {
      await fs.rm(partialDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.artifactPath(actual);
  }

  /**
   * Throw unless the packed artifact still hashes to `digest` and imports nothing but runtime
   * built-ins, since its digest-addressed directory holds no other file it could import.
   */
  async assertIntact(digest: string): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await readRegularFile(this.artifactPath(digest), MAX_PLUGIN_ARTIFACT_BYTES);
    } catch (error) {
      throw new Error(`artifact is missing or unreadable: ${toError(error).message}`, {
        cause: error,
      });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("artifact failed digest verification");
    }
    await scanPluginImportGraph(path.dirname(this.artifactPath(digest)), PACKED_ARTIFACT_NAME);
  }

  /** {@link assertIntact} as a boolean. */
  async verify(digest: string): Promise<boolean> {
    try {
      await this.assertIntact(digest);
      return true;
    } catch {
      return false;
    }
  }

  async removeDigest(digest: string): Promise<void> {
    await fs.rm(path.dirname(this.artifactPath(digest)), { recursive: true, force: true });
  }

  private async acquireArtifact(
    manifest: PluginManifest,
    manifestSource: URL,
  ): Promise<Uint8Array> {
    if (manifestSource.protocol === "file:") {
      const manifestPath = fileURLToPath(manifestSource);
      const base = await fs.realpath(path.dirname(manifestPath));
      const requested = path.resolve(base, manifest.artifact);
      if (!isPathWithin(base, requested))
        throw new Error("Local plugin artifact escapes manifest directory");
      const real = await fs.realpath(requested);
      if (!isPathWithin(base, real))
        throw new Error("Local plugin artifact resolves outside manifest directory");
      return readRegularFile(real, MAX_PLUGIN_ARTIFACT_BYTES);
    }
    const artifactUrl = new URL(manifest.artifact, manifestSource);
    if (artifactUrl.protocol !== "https:" || artifactUrl.origin !== manifestSource.origin) {
      throw new Error("Remote plugin artifact must stay on the manifest HTTPS origin");
    }
    return (await fetchSameOrigin(artifactUrl, MAX_PLUGIN_ARTIFACT_BYTES, this.fetchImpl)).bytes;
  }
}

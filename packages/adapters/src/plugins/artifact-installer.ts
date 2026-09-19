/**
 * Acquires plugin manifests and executable artifacts without executing them.
 *
 * Remote downloads are HTTPS-only, same-origin across redirects, byte-bounded,
 * and hashed while streaming. Local artifacts must be regular, non-symlink
 * files contained by the manifest directory. Verified modules are installed in
 * digest-addressed directories through a sibling partial directory + rename.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_PLUGIN_ARTIFACT_BYTES,
  MAX_PLUGIN_MANIFEST_BYTES,
  parsePluginManifest,
  type PluginManifest,
} from "./manifest-schema";

const MAX_REDIRECTS = 3;

export interface AcquiredManifest {
  readonly manifest: PluginManifest;
  readonly source: URL;
}

async function boundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > limit)
    throw new Error(`Download exceeds ${limit} bytes`);
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel("download too large");
      throw new Error(`Download exceeds ${limit} bytes`);
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function fetchSameOrigin(
  source: URL,
  limit: number,
  fetchImpl: typeof fetch,
): Promise<{ readonly bytes: Uint8Array; readonly finalUrl: URL }> {
  if (source.protocol !== "https:") throw new Error("Remote plugin sources must use HTTPS");
  const allowedOrigin = source.origin;
  let current = source;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json, text/javascript" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null || redirects === MAX_REDIRECTS)
        throw new Error("Invalid redirect chain");
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.origin !== allowedOrigin) {
        throw new Error("Plugin download redirected outside its trusted HTTPS origin");
      }
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`Plugin download failed with HTTP ${response.status}`);
    if (new URL(response.url || current.toString()).origin !== allowedOrigin) {
      throw new Error("Plugin download ended outside its trusted origin");
    }
    return { bytes: await boundedResponseBytes(response, limit), finalUrl: current };
  }
  throw new Error("Invalid redirect chain");
}

async function readRegularFile(filePath: string, limit: number): Promise<Uint8Array> {
  const linkStat = await fs.lstat(filePath);
  if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
    throw new Error(`Plugin source is not a regular non-symlink file: ${filePath}`);
  }
  if (linkStat.size > limit) throw new Error(`Plugin source exceeds ${limit} bytes`);
  return new Uint8Array(await fs.readFile(filePath));
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
    return path.join(this.options.pluginDirectory, "artifacts", digest, "plugin.mjs");
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
      const partialFile = path.join(partialDirectory, "plugin.mjs");
      await fs.writeFile(partialFile, bytes, { mode: 0o600, flag: "wx" });
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

  async verify(digest: string): Promise<boolean> {
    try {
      const bytes = await readRegularFile(this.artifactPath(digest), MAX_PLUGIN_ARTIFACT_BYTES);
      return createHash("sha256").update(bytes).digest("hex") === digest;
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
      if (!isWithin(base, requested))
        throw new Error("Local plugin artifact escapes manifest directory");
      const real = await fs.realpath(requested);
      if (!isWithin(base, real))
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

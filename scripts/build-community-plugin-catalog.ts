/**
 * Refresh the checked-in community plugin snapshot from GitHub's public metadata APIs.
 *
 * The refresh job reads repository metadata and `jazz-plugin.json` only. It never checks out,
 * installs, builds, imports, or executes a community repository. A failed refresh leaves the last
 * good snapshot untouched so website builds remain deterministic and offline-capable.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  discoverCommunityPlugins,
  type CommunityPluginEntry,
  type GitHubPluginDiscoveryOptions,
} from "./github-plugin-discovery";

const DEFAULT_OUTPUT_PATH = path.resolve("packages/website/src/data/community-plugin-catalog.json");

interface CommunityCatalog {
  readonly schemaVersion: 1;
  readonly plugins: readonly CommunityPluginEntry[];
}

async function readPreviousCatalog(outputPath: string): Promise<CommunityCatalog> {
  try {
    const parsed = JSON.parse(await readFile(outputPath, "utf8")) as {
      schemaVersion?: unknown;
      plugins?: unknown;
    };
    if (parsed["schemaVersion"] !== 1 || !Array.isArray(parsed["plugins"])) {
      throw new Error(`Invalid community plugin catalog at ${outputPath}`);
    }
    return parsed as CommunityCatalog;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1, plugins: [] };
    }
    throw error;
  }
}

function preserveStableTimestamps(
  next: readonly CommunityPluginEntry[],
  previous: readonly CommunityPluginEntry[],
): CommunityPluginEntry[] {
  const previousById = new Map(previous.map((entry) => [entry.id, entry]));
  return next.map((entry) => {
    const old = previousById.get(entry.id);
    return old?.sourceSha === entry.sourceSha && old.manifestSha256 === entry.manifestSha256
      ? { ...entry, indexedAt: old.indexedAt }
      : entry;
  });
}

/** Refresh the community snapshot, writing it only after a complete successful discovery. */
export async function buildCommunityPluginCatalog(
  options: {
    readonly discovery?: GitHubPluginDiscoveryOptions;
    readonly outputPath?: string;
  } = {},
): Promise<CommunityCatalog> {
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const previous = await readPreviousCatalog(outputPath);
  const discovered = await discoverCommunityPlugins(options.discovery);
  const catalog: CommunityCatalog = {
    schemaVersion: 1,
    plugins: preserveStableTimestamps(discovered, previous.plugins),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await rename(temporaryPath, outputPath);
  return catalog;
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  buildCommunityPluginCatalog().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

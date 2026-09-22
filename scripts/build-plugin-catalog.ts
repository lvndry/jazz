/**
 * Rebuild the reviewed and community plugin catalogs into `.build/plugin-catalog`.
 * Reviewed entries publish packer-generated artifacts; community entries remain metadata-only.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { packPlugin } from "@jazz/adapters/plugins";

const OFFICIAL_PLUGINS = ["plugins/jev"] as const;
const OUTPUT_DIRECTORY = path.resolve(".build/plugin-catalog");
const COMMUNITY_CATALOG_SOURCE = path.resolve(
  "packages/website/src/data/community-plugin-catalog.json",
);

interface CatalogRoute {
  readonly path: string;
  readonly file: string;
  readonly contentType: string;
}

/** Build every reviewed plugin and emit the routes consumed by the static site. */
export async function buildPluginCatalog(): Promise<void> {
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const routes: CatalogRoute[] = [];
  const plugins: Record<string, unknown>[] = [];

  for (const sourceDirectory of OFFICIAL_PLUGINS) {
    const sourceManifest = JSON.parse(
      await readFile(path.join(sourceDirectory, "jazz-plugin.json"), "utf8"),
    ) as { readonly id: string; readonly version: string };
    const releaseDirectory = path.join(OUTPUT_DIRECTORY, sourceManifest.id, sourceManifest.version);
    const packed = await packPlugin({
      pluginDirectory: sourceDirectory,
      releaseDirectory,
    });
    const manifest = JSON.parse(await readFile(packed.catalogEntryPath, "utf8")) as Record<
      string,
      unknown
    >;
    const artifactPath = `/library/plugins/${sourceManifest.id}/${sourceManifest.version}/${packed.sha256}.mjs`;
    // Keep the reviewed catalog entry a valid install manifest. Website-only provenance is
    // inferred by the absence of community metadata, so `jazz plugin add <id>` can consume it.
    const publicManifest = { ...manifest, artifact: artifactPath };
    const manifestFile = path.join(OUTPUT_DIRECTORY, `${sourceManifest.id}.json`);
    await writeFile(manifestFile, `${JSON.stringify(publicManifest, null, 2)}\n`, "utf8");
    plugins.push(publicManifest);
    routes.push(
      {
        path: `${sourceManifest.id}.json`,
        file: manifestFile,
        contentType: "application/json; charset=utf-8",
      },
      {
        path: `${sourceManifest.id}/${sourceManifest.version}/${packed.sha256}.mjs`,
        file: packed.artifactPath,
        contentType: "text/javascript; charset=utf-8",
      },
    );
  }

  await writeFile(
    path.join(OUTPUT_DIRECTORY, "plugins.json"),
    `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`,
    "utf8",
  );

  const communityCatalog = await readFile(COMMUNITY_CATALOG_SOURCE, "utf8");
  await writeFile(path.join(OUTPUT_DIRECTORY, "community-plugins.json"), communityCatalog, "utf8");
  await writeFile(
    path.join(OUTPUT_DIRECTORY, "routes.json"),
    `${JSON.stringify(routes, null, 2)}\n`,
    "utf8",
  );
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  buildPluginCatalog().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

/**
 * Rebuild the reviewed first-party plugin catalog into `.build/plugin-catalog`.
 * The website publishes only these packer-generated manifests and artifacts.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { packPlugin } from "@jazz/adapters/plugins";

const OFFICIAL_PLUGINS = ["plugins/jev-skill-router"] as const;
const OUTPUT_DIRECTORY = path.resolve(".build/plugin-catalog");

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

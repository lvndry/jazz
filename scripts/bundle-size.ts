/**
 * Reports what a standalone binary's bundle actually contains, by package.
 *
 * Builds the entry with the same flags, plugins, and embedded-asset module as
 * the real compile (so the graph is the same), then reads Bun's metafile and
 * attributes each module's post-tree-shake output size to its package. The
 * result answers "why is the binary big" and catches a dependency quietly
 * growing before it costs a release to notice.
 *
 * Usage:
 *   bun run scripts/bundle-size.ts              # top 25 packages
 *   bun run scripts/bundle-size.ts --top 40     # more
 *   bun run scripts/bundle-size.ts --json       # machine-readable
 *
 * Attribution caveats, stated rather than papered over:
 * - Byte counts are per *module*, and a module's bytes may be shared by
 *   several output chunks; the total is an upper bound on deduplicated size.
 * - Platform-specific native packages (e.g. `@opentui/core-<platform>`) that
 *   are not installed on this machine resolve to nothing and are absent.
 */

import path from "node:path";
import { createStandalonePlugins, generateEmbeddedAssetsModule } from "./build-helpers";

const argIndex = process.argv.indexOf("--");
const args = argIndex === -1 ? [] : process.argv.slice(argIndex + 1);
const topFlag = args.indexOf("--top");
const top = topFlag !== -1 ? Number(args[topFlag + 1]) : 25;
const asJson = args.includes("--json");

process.env["NODE_ENV"] = "production";

const compileTarget = "bun-darwin-arm64";
const targetPlatform = compileTarget.split("-")[1] ?? "";
const generatedAssets = generateEmbeddedAssetsModule(targetPlatform);
const outdir = path.join(".build", "bundle-size");

const result = await Bun.build({
  entrypoints: ["packages/runtime/src/entry.ts"],
  target: "bun",
  minify: true,
  splitting: true,
  format: "esm",
  outdir,
  metafile: true,
  plugins: createStandalonePlugins(generatedAssets),
});

if (!result.success || result.metafile === undefined) {
  for (const message of result.logs) process.stderr.write(`${message.message}\n`);
  throw new Error("Build for analysis failed");
}

const meta = result.metafile;

const byPackage = new Map<string, number>();
let total = 0;
for (const output of Object.values(meta.outputs ?? {})) {
  for (const [input, info] of Object.entries(output.inputs ?? {})) {
    const bytes = info.bytesInOutput ?? 0;
    // Bun's virtual store nests packages under node_modules/.bun/<id>/node_modules/<name>,
    // so the plain node_modules/ match would swallow everything as ".bun".
    const match =
      input.match(/\.bun\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/) ??
      input.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    const key = match?.[1] ?? "(workspace)";
    byPackage.set(key, (byPackage.get(key) ?? 0) + bytes);
    total += bytes;
  }
}

const sorted = [...byPackage.entries()].sort((a, b) => b[1] - a[1]);
const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2);

if (asJson) {
  process.stdout.write(
    JSON.stringify(
      {
        totalBytes: total,
        packages: sorted.map(([name, bytes]) => ({ name, bytes })),
      },
      null,
      2,
    ) + "\n",
  );
} else {
  process.stdout.write(`Post-tree-shake bundle: ${megabytes(total)} MB attributed\n`);
  for (const [name, bytes] of sorted.slice(0, top)) {
    process.stdout.write(`  ${megabytes(bytes).padStart(7)} MB  ${name}\n`);
  }
  const rest = sorted.slice(top).reduce((sum, [, bytes]) => sum + bytes, 0);
  if (rest > 0) {
    process.stdout.write(`  ${megabytes(rest).padStart(7)} MB  (everything else)\n`);
  }
  process.stdout.write(
    "Native libraries (libopentui, tree-sitter) and the Bun runtime are not in this total.\n",
  );
}

/**
 * Real filesystem approval scans and configuration validation, plus provider
 * catalog decoding/resolution through ModelFetcher. Fixtures are isolated;
 * catalog HTTP responses are in-memory Responses, excluding server latency.
 * Config validation deliberately excludes keyring/service startup (measured
 * by compiled-startup). Run `bun run bench filesystem-config-models`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { benchAsync, report } from "./harness";
import { validateConfigFiles } from "../packages/adapters/src/config";
import { createModelFetcher } from "../packages/adapters/src/llm/model-fetcher";
import { measureFootprint } from "../packages/core/src/agent/tools/fs/footprint";

const root = mkdtempSync(join(tmpdir(), "jazz-bench-boundaries-"));
const previousCwd = process.cwd();
const previousFetch = globalThis.fetch;
process.env["JAZZ_HOME"] = root;
process.chdir(root);
const options = { iterations: 20, warmupIterations: 2 };
const trees = [100, 1_000, 10_050].map((count) => {
  const directory = join(root, `tree-${count}`);
  mkdirSync(directory);
  for (let file = 0; file < count; file += 1)
    writeFileSync(join(directory, `file-${file}`), "fixture");
  return { directory, count };
});
const configPath = join(root, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({ logging: { level: "info" }, storage: { type: "file", path: root } }),
);
const catalog = JSON.stringify({
  openrouter: {
    models: Object.fromEntries(
      Array.from({ length: 1_000 }, (_, i) => [
        `fixture-${i}`,
        { name: `Fixture ${i}`, limit: { context: 128_000 }, tool_call: true },
      ]),
    ),
  },
});
mkdirSync(join(root, "cache"), { recursive: true });
writeFileSync(join(root, "cache", "models-dev.json"), catalog);
let providerBody = "";
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://models.dev/api.json") return new Response(catalog);
    if (url === "https://fixture.invalid/models") return new Response(providerBody);
    throw new Error(`Unexpected benchmark network request: ${url}`);
  },
  { preconnect: previousFetch.preconnect },
) as typeof fetch;

try {
  const results = [];
  for (const { directory, count } of trees) {
    results.push(
      await benchAsync(
        `approval footprint (${count} files)`,
        async () => {
          const footprint = await Effect.runPromise(
            measureFootprint(directory).pipe(Effect.provide(NodeFileSystem.layer)),
          );
          if (footprint === undefined || footprint.files !== Math.min(count, 10_000))
            throw new Error("Invalid footprint workload");
        },
        options,
      ),
    );
  }
  results.push(
    await benchAsync(
      "configuration read + validation + defaults",
      async () => {
        await Effect.runPromise(
          validateConfigFiles(configPath).pipe(Effect.provide(NodeFileSystem.layer)),
        );
      },
      options,
    ),
  );
  const fetcher = createModelFetcher();
  for (const count of [100, 1_000]) {
    providerBody = JSON.stringify({
      data: Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}` })),
    });
    results.push(
      await benchAsync(
        `model discovery (${count} models, warm metadata)`,
        async () => {
          const models = await Effect.runPromise(
            fetcher.fetchModels("openrouter", "https://fixture.invalid", "/models", "fixture-key"),
          );
          if (models.length !== count) throw new Error("Invalid catalog workload");
        },
        options,
      ),
    );
  }
  report("filesystem-config-models", results);
} finally {
  globalThis.fetch = previousFetch;
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
}

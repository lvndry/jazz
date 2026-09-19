/** Command-line wrapper around the canonical adapter-side plugin packer. */

import { packPlugin } from "@jazz/adapters/plugins";

export { packPlugin } from "@jazz/adapters/plugins";

async function main(): Promise<void> {
  const pluginDirectory = process.argv[2];
  if (pluginDirectory === undefined) {
    throw new Error("Usage: bun run scripts/plugin-pack.ts <plugin-directory>");
  }
  const result = await packPlugin({ pluginDirectory });
  process.stdout.write(`${result.artifactPath}\n${result.sha256}\n`);
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

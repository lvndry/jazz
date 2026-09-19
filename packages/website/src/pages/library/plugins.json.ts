/** Static first-party plugin catalog generated from reviewed source before the Astro build. */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const catalogPath = fileURLToPath(
  new URL("../../../../../.build/plugin-catalog/plugins.json", import.meta.url),
);

export async function GET(): Promise<Response> {
  return new Response(await readFile(catalogPath), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

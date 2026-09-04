import { getMarketplaceEntries, toIndexEntry } from "../../lib/marketplace";

/**
 * The catalog `jazz persona browse` reads. Static, cache-friendly, and the only
 * contract between the CLI and this site — see packages/adapters/src/persona-registry-service.ts.
 */
export async function GET(): Promise<Response> {
  const entries = await getMarketplaceEntries();
  const index = { version: 1, personas: entries.map(toIndexEntry) };
  return new Response(JSON.stringify(index, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

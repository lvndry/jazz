/** Static metadata-only index for community plugins; never an installable manifest endpoint. */

import { getPluginEntries } from "../../lib/library";

export async function GET(): Promise<Response> {
  const plugins = (await getPluginEntries()).filter((entry) => entry.sourceType === "community");
  return new Response(JSON.stringify({ schemaVersion: 1, plugins }, null, 2), {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

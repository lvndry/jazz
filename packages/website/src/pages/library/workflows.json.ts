import { getWorkflowEntries, toWorkflowIndexEntry } from "../../lib/library";

/**
 * The catalog `jazz workflow browse` reads. Static, cache-friendly, and the only
 * contract between the CLI and this site — see packages/adapters/src/workflow-registry-service.ts.
 */
export async function GET(): Promise<Response> {
  const entries = await getWorkflowEntries();
  const index = { version: 1, workflows: entries.map(toWorkflowIndexEntry) };
  return new Response(JSON.stringify(index, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

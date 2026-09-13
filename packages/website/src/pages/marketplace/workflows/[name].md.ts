import {
  getWorkflowEntries,
  readWorkflowSource,
  type WorkflowEntry,
} from "../../../lib/marketplace";

export async function getStaticPaths() {
  const entries = await getWorkflowEntries();
  return entries.map((entry) => ({
    params: { name: entry.data.name },
    props: { entry },
  }));
}

/** The raw `WORKFLOW.md`, byte for byte what `jazz workflow install` writes to disk. */
export async function GET(context: { props: { entry: WorkflowEntry } }): Promise<Response> {
  return new Response(await readWorkflowSource(context.props.entry), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

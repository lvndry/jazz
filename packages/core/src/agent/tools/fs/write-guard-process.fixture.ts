/** Runs a parked write in a fresh process, where proposal caches cannot preserve its baseline. */
import { z } from "zod";
import { runTool } from "./test-helpers";
import { createWriteFileTools } from "./write";

const { directory, input, toolCallId, snapshot } = z
  .object({
    directory: z.string(),
    input: z.object({ path: z.string(), content: z.string() }),
    toolCallId: z.string(),
    snapshot: z.object({ key: z.string(), version: z.string() }).optional(),
  })
  .parse(JSON.parse(process.argv[2] ?? "null"));
const tools = createWriteFileTools();
await runTool(tools.approval, input, directory, { toolCallId });
const result = await runTool(tools.execute, input, directory, {
  toolCallId,
  resumedApproval: true,
  ...(snapshot === undefined ? {} : { approvedWriteSnapshot: snapshot }),
});
process.stdout.write(JSON.stringify(result));

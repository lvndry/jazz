import { Effect } from "effect";
import { z } from "zod";
import { GmailServiceTag, type GmailService } from "@/core/interfaces/gmail";
import type { Tool } from "@/core/interfaces/tool-registry";
import { defineTool } from "../base-tool";
import { formatLabelsForDisplay } from "./utils";

/**
 * List labels tool
 */

export function createListLabelsTool(): Tool<GmailService> {
  const parameters = z.object({}).strict();

  type ListLabelsArgs = z.infer<typeof parameters>;
  return defineTool<GmailService, ListLabelsArgs>({
    name: "list_labels",
    description:
      "List all available Gmail labels including system labels (INBOX, SENT, TRASH, etc.) and user-created labels. Returns label IDs, names, types, message counts, and color settings. Use to discover available labels before applying them to emails.",
    tags: ["gmail", "labels"],
    parameters,
    validate: (args) => {
      const params = parameters.safeParse(args);
      return params.success
        ? ({ valid: true, value: params.data as unknown as Record<string, never> } as const)
        : ({ valid: false, errors: params.error.issues.map((i) => i.message) } as const);
    },
    handler: () =>
      Effect.gen(function* () {
        const gmailService = yield* GmailServiceTag;
        const labels = yield* gmailService.listLabels();
        return { success: true, result: formatLabelsForDisplay(labels) };
      }),
  });
}

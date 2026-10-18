/**
 * `post_to_blackboard` and `read_blackboard`: how a parent and its sub-agents share findings
 * while they work, through the run's `Blackboard` instead of the parent's context.
 */
import { Effect } from "effect";
import { z } from "zod";
import type { Tool, ToolRequirements } from "@/core/interfaces/tool-registry";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types/tools";
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "@/core/utils/tool-result-formatter";
import { defineTool, makeZodValidator } from "./base-tool";
import {
  MAX_BLACKBOARD_POST_CHARS,
  type BlackboardEntry,
  type BlackboardRead,
} from "../subagents/blackboard";

const MAX_TOPIC_CHARS = 80;

const postSchema = z
  .object({
    topic: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TOPIC_CHARS)
      .describe("Short tag readers filter by, e.g. 'pricing' or 'auth flow'."),
    content: z
      .string()
      .trim()
      .min(1)
      .max(MAX_BLACKBOARD_POST_CHARS)
      .describe("The finding, with the path, URL or evidence another agent needs to use it."),
  })
  .strict();

const readSchema = z
  .object({
    afterId: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("nextAfterId from your last read, for only newer posts."),
    topic: z.string().trim().min(1).optional().describe("Only posts with this topic."),
  })
  .strict();

type PostArgs = z.infer<typeof postSchema>;
type ReadArgs = z.infer<typeof readSchema>;

const NO_BLACKBOARD_ERROR = "There is no blackboard in this run.";

function authorName(context: ToolExecutionContext): string {
  return context.parentAgent?.name ?? context.agentId;
}

/**
 * The posts that fit in one tool result, oldest first. `nextAfterId` is the last post returned,
 * so a reader that was cut off reads on from there.
 */
export function fitBlackboardRead(read: BlackboardRead, maxChars: number) {
  const fitted: BlackboardEntry[] = [];
  let size = 0;
  for (const entry of read.entries) {
    const entrySize = JSON.stringify(entry).length;
    if (fitted.length > 0 && size + entrySize > maxChars) {
      break;
    }
    fitted.push(entry);
    size += entrySize;
  }
  const remaining = read.entries.length - fitted.length;
  const lastReturned = fitted.at(-1);
  return {
    entries: fitted,
    ...(lastReturned !== undefined ? { nextAfterId: lastReturned.id } : {}),
    ...(remaining > 0 ? { more: remaining } : {}),
    ...(read.dropped > 0 ? { dropped: read.dropped } : {}),
  };
}

export function createBlackboardTools(): Tool<ToolRequirements>[] {
  return [
    defineTool({
      name: "post_to_blackboard",
      disclosure: "private",
      description:
        "Post a finding to the blackboard your parent and sibling sub-agents share, so they can build on it while they work. Post what another agent could use: a located file, a ruled-out lead, a fact with its source. Returns the post's id.",
      parameters: postSchema,
      hidden: false,
      peerGrantRequired: true,
      riskLevel: "read-only",
      validate: makeZodValidator(postSchema),
      handler: (args: PostArgs, context) =>
        Effect.sync((): ToolExecutionResult => {
          const blackboard = context.blackboard;
          if (blackboard === undefined) {
            return { success: false, result: null, error: NO_BLACKBOARD_ERROR };
          }
          const author = authorName(context);
          const entry = blackboard.post({
            author,
            topic: args.topic,
            content: args.content,
            ...(context.egressTaint?.isTainted() === true
              ? { untrusted: { kind: "external", source: `blackboard post by ${author}` } }
              : {}),
          });
          return { success: true, result: { id: entry.id } };
        }),
      createSummary: (result) =>
        result.success ? "Posted to the blackboard" : `post_to_blackboard failed: ${result.error}`,
    }),
    defineTool({
      name: "read_blackboard",
      disclosure: "private",
      description:
        "Read what your parent and sibling sub-agents posted to the shared blackboard, oldest first. Read before starting work another agent may have done; pass nextAfterId from your last read for only newer posts.",
      parameters: readSchema,
      hidden: false,
      peerGrantRequired: true,
      riskLevel: "read-only",
      validate: makeZodValidator(readSchema),
      handler: (args: ReadArgs, context) =>
        Effect.sync((): ToolExecutionResult => {
          const blackboard = context.blackboard;
          if (blackboard === undefined) {
            return { success: false, result: null, error: NO_BLACKBOARD_ERROR };
          }
          const read = fitBlackboardRead(
            blackboard.read({
              ...(args.afterId !== undefined ? { afterId: args.afterId } : {}),
              ...(args.topic !== undefined ? { topic: args.topic } : {}),
            }),
            DEFAULT_TOOL_RESULT_MAX_CHARS,
          );
          const untrustedAuthors = [
            ...new Set(
              read.entries.filter((entry) => entry.untrusted).map((entry) => entry.author),
            ),
          ];
          return {
            success: true,
            result: read,
            ...(untrustedAuthors.length > 0
              ? {
                  untrusted: {
                    kind: "external",
                    source: `blackboard posts by ${untrustedAuthors.join(", ")}`,
                  },
                }
              : {}),
          };
        }),
      createSummary: (result) =>
        result.success ? "Read the blackboard" : `read_blackboard failed: ${result.error}`,
    }),
  ] as Tool<ToolRequirements>[];
}

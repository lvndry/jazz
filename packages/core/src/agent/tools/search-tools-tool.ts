/** Fetches full schemas for `deferred`-tier tools on demand. See docs/superpowers/plans/tool-search-design.md. */
import { Effect } from "effect";
import { z } from "zod";
import { ToolRegistryTag, type Tool, type ToolRegistry } from "@/core/interfaces/tool-registry";
import type { ToolExecutionResult } from "@/core/types/tools";

/** Caps schemas per call so a broad query can't dump the entire deferred surface into context. */
export const MAX_SEARCH_TOOLS_RESULTS = 8;

/** Ranks by case-insensitive token overlap against name + summary. No embeddings; revisit only past a few hundred deferred tools. */
export function rankToolsByQuery(
  query: string,
  candidates: readonly { readonly name: string; readonly summary: string }[],
): readonly string[] {
  // Tokens under 3 chars ("a", "to", "in") match as a substring almost everywhere and would
  // turn any query containing one into a false-positive match against unrelated tools.
  const queryTokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length >= 3);
  if (queryTokens.length === 0) return [];

  const scored = candidates
    .map((candidate) => {
      const haystack = `${candidate.name} ${candidate.summary}`.toLowerCase();
      const score = queryTokens.reduce(
        (total, token) => total + (haystack.includes(token) ? 1 : 0),
        0,
      );
      return { name: candidate.name, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_SEARCH_TOOLS_RESULTS).map((candidate) => candidate.name);
}

const searchToolsParameters = z.object({
  query: z
    .string()
    .min(1, "query cannot be empty")
    .describe("Keywords describing the capability you need, e.g. 'create linear issue'."),
});

export function createSearchToolsTool(): Tool<ToolRegistry> {
  return {
    name: "search_tools",
    disclosure: "internal",
    description:
      "Fetch full parameter schemas for tools you can currently see only by name and one-line summary in your tool list (MCP server tools, background jobs, reminders, wake triggers, workspace, peers). " +
      "Call this before attempting to use one of them — once fetched, the tool becomes directly callable for the rest of this conversation. " +
      "Do not use execute_command to replicate what a listed-but-unfetched tool already does; search for it here instead.",
    parameters: searchToolsParameters,
    riskLevel: "read-only",
    hidden: false,
    createSummary: (result) => {
      if (!result.success) return undefined;
      const matched = (result.result as { matchedToolNames?: readonly string[] } | null)
        ?.matchedToolNames;
      return matched && matched.length > 0
        ? `Found ${matched.length} tool(s): ${matched.join(", ")}`
        : "No matching tools found";
    },
    execute: (args, context) =>
      Effect.gen(function* () {
        const { query } = searchToolsParameters.parse(args);
        const registry = yield* ToolRegistryTag;
        const deferredToolNames = context.deferredToolNames ?? [];

        if (deferredToolNames.length === 0) {
          return {
            success: true,
            result: { matchedToolNames: [], definitions: [] },
          } satisfies ToolExecutionResult;
        }

        const summaries = yield* registry.getToolSummaries(deferredToolNames);
        const matchedNames = rankToolsByQuery(query, summaries);

        if (matchedNames.length === 0) {
          return {
            success: true,
            result: {
              matchedToolNames: [],
              definitions: [],
              message:
                "No deferred tool matched that query. Check the tool list's names/summaries for a closer match, or fall back to execute_command only if truly no tool covers this.",
            },
          } satisfies ToolExecutionResult;
        }

        const definitions = yield* registry.getToolDefinitionsFor(matchedNames);
        context.unlockDeferredTools?.(definitions);

        return {
          success: true,
          result: {
            matchedToolNames: definitions.map((definition) => definition.function.name),
            definitions: definitions.map((definition) => definition.function),
          },
        } satisfies ToolExecutionResult;
      }),
  };
}

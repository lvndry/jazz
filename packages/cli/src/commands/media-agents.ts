/**
 * @fileoverview Finding which of your agents can generate media
 *
 * Producing media is a capability of a model, not something jazz can hand to any agent: either
 * the agent's own model makes it, or a `generate:<modality>` companion it has bound does.
 * The cost of that is discoverability — "use a model that can" is useless advice if you cannot
 * see which of your agents qualify, or which model to pick when none do.
 *
 * This answers both questions: the agents that can, and, when there are none, a concrete model
 * to create one with.
 */

import { OPENROUTER_GATEWAY_MODELS } from "@jazz/core/constants/models";
import type { Agent } from "@jazz/core/types/agent";
import { companionRole, type MediaModality } from "@jazz/core/types/llm";
import { modelSupportsRole } from "@jazz/core/utils/model-capabilities";
import {
  getModelsDevMetadata,
  getModelsDevProviderModels,
  type ModelsDevMetadata,
  type ModelsDevModelEntry,
} from "@jazz/core/utils/models-dev";

function metadataGenerates(
  metadata: ModelsDevMetadata | undefined,
  modality: MediaModality,
): boolean {
  if (metadata === undefined) return false;
  return modelSupportsRole(metadata, companionRole("generate", modality));
}

export interface CapableAgent {
  readonly agent: Agent;
  /** True when the agent can also call tools, which most media models cannot. */
  readonly supportsTools: boolean;
  /** The bound companion doing the producing, when it is not the agent's own model. */
  readonly via?: string;
}

/**
 * The agents that produce `modality`, by their own model or by a bound companion.
 *
 * `supportsTools` rides along because it is the difference between an agent that can draw *and*
 * work, and one that can only draw — most image models report `tool_call: false`, so an agent on
 * `gemini-3-pro-image` cannot read a file or search the web. Someone choosing between two image
 * agents needs to know that before they pick. A companion-backed agent usually has both: its own
 * model keeps the tools, the companion does the drawing.
 *
 * A binding counts without checking the catalog. Unlike a model's own metadata — where unknown
 * reads as "no" rather than a guess — a binding is a deliberate statement by the person who
 * wrote it, and second-guessing it would hide an agent that works.
 */
export async function findAgentsThatGenerate(
  agents: readonly Agent[],
  modality: MediaModality,
): Promise<CapableAgent[]> {
  const capable: CapableAgent[] = [];
  for (const agent of agents) {
    let metadata: ModelsDevMetadata | undefined;
    try {
      metadata = await getModelsDevMetadata(agent.config.llmModel, agent.config.llmProvider);
    } catch {
      // An unreachable catalog should not make every agent look incapable, but there is nothing
      // better to say about its own model than "unknown", which reads the same as "no". A
      // binding, below, is still a fact.
    }
    if (metadataGenerates(metadata, modality)) {
      capable.push({ agent, supportsTools: metadata?.supportsTools === true });
      continue;
    }
    const bound = agent.config.companions?.[companionRole("generate", modality)];
    if (bound !== undefined) {
      capable.push({ agent, supportsTools: metadata?.supportsTools === true, via: bound });
    }
  }
  return capable;
}

/**
 * Models that could back a new agent for this modality, best first.
 *
 * Tool-capable models are ranked first because an agent that can only produce media is a much
 * narrower thing than one that can also do the work around it.
 */
export async function suggestModelsForModality(
  modality: MediaModality,
  providers: readonly string[],
  limit = 4,
): Promise<{ id: string; provider: string; supportsTools: boolean }[]> {
  const suggestions: { id: string; provider: string; supportsTools: boolean }[] = [];

  for (const provider of providers) {
    let entries: readonly ModelsDevModelEntry[];
    try {
      entries = await getModelsDevProviderModels(provider);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.status === "deprecated") continue;
      // A router advertises what it might reach. Recommending it for image generation would send
      // someone to a model that may or may not be able to do the thing they asked for.
      if (OPENROUTER_GATEWAY_MODELS.has(entry.id)) continue;
      if (!metadataGenerates(entry.metadata, modality)) continue;
      // Only models jazz will let you select: it must hold a conversation.
      if (!entry.inputModalities.includes("text") || !entry.outputModalities.includes("text")) {
        continue;
      }
      suggestions.push({
        id: entry.id,
        provider,
        supportsTools: entry.metadata.supportsTools,
      });
    }
  }

  suggestions.sort((left, right) => Number(right.supportsTools) - Number(left.supportsTools));
  return suggestions.slice(0, limit);
}

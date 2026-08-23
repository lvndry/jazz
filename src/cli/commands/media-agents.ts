/**
 * @fileoverview Finding which of your agents can generate media
 *
 * Jazz has no image-generation tool on purpose: producing media is a capability of the model an
 * agent runs on, not something jazz can hand to any agent (see the media-generation decision).
 * The cost of that choice is discoverability — "use a model that can" is useless advice if you
 * cannot see which of your agents qualify, or which model to pick when none do.
 *
 * This answers both questions: the agents that can, and, when there are none, a concrete model
 * to create one with.
 */

import { OPENROUTER_GATEWAY_MODELS } from "@/core/constants/models";
import type { Agent } from "@/core/types/agent";
import {
  getModelsDevMetadata,
  getModelsDevProviderModels,
  type ModelsDevMetadata,
  type ModelsDevModelEntry,
} from "@/core/utils/models-dev";
import { parseProviderModel } from "@/core/utils/provider-model";

/** The media an agent can be asked to produce. */
export type MediaCapability = "image" | "audio" | "video";

export const MEDIA_CAPABILITIES: readonly MediaCapability[] = ["image", "audio", "video"];

export function isMediaCapability(value: string): value is MediaCapability {
  return (MEDIA_CAPABILITIES as readonly string[]).includes(value);
}

function metadataHasCapability(
  metadata: ModelsDevMetadata | undefined,
  capability: MediaCapability,
): boolean {
  if (metadata === undefined) return false;
  if (capability === "image") return metadata.generatesImage;
  if (capability === "audio") return metadata.generatesAudio;
  return metadata.generatesVideo;
}

export interface CapableAgent {
  readonly agent: Agent;
  /** True when the agent can also call tools, which most media models cannot. */
  readonly supportsTools: boolean;
}

/**
 * The agents whose model produces `capability`.
 *
 * `supportsTools` rides along because it is the difference between an agent that can draw *and*
 * work, and one that can only draw — most image models report `tool_call: false`, so an agent on
 * `gemini-3-pro-image` cannot read a file or search the web. Someone choosing between two image
 * agents needs to know that before they pick.
 */
export async function findAgentsWithCapability(
  agents: readonly Agent[],
  capability: MediaCapability,
): Promise<CapableAgent[]> {
  const capable: CapableAgent[] = [];
  for (const agent of agents) {
    const parsed = parseProviderModel(agent.model);
    if (parsed === null) continue;

    let metadata: ModelsDevMetadata | undefined;
    try {
      metadata = await getModelsDevMetadata(parsed.model, parsed.provider);
    } catch {
      // An unreachable catalog should not make every agent look incapable, but there is nothing
      // better to say about this one than "unknown", which reads the same as "no".
      continue;
    }
    if (metadataHasCapability(metadata, capability)) {
      capable.push({ agent, supportsTools: metadata?.supportsTools === true });
    }
  }
  return capable;
}

/**
 * Models that could back a new agent for this capability, best first.
 *
 * Tool-capable models are ranked first because an agent that can only produce media is a much
 * narrower thing than one that can also do the work around it.
 */
export async function suggestModelsForCapability(
  capability: MediaCapability,
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
      if (!metadataHasCapability(entry.metadata, capability)) continue;
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

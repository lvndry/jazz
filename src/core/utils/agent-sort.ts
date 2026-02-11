import type { Agent } from "@/core/types/index";

/**
 * Sort agents with the last-used agent first, then alphabetically by name.
 *
 * @param agents - The array of agents to sort
 * @param lastUsedAgentId - The ID of the last-used agent (if any)
 * @returns A new sorted array of agents
 */
export function sortAgents<T extends Pick<Agent, "id" | "name">>(
  agents: readonly T[],
  lastUsedAgentId?: string | null,
): T[] {
  return [...agents].sort((a, b) => {
    if (lastUsedAgentId) {
      if (a.id === lastUsedAgentId) return -1;
      if (b.id === lastUsedAgentId) return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

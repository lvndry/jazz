/**
 * Stable presentation ordering for agent selection and management surfaces.
 *
 * This module lives with the agent domain because it defines ordering for
 * agent-shaped values while remaining independent of any specific UI.
 */
import type { Agent } from "@/core/types/index";

/**
 * Sort agent-shaped objects with the last-used agent first, then by name.
 *
 * The input is not mutated. Equal names retain their original relative order
 * because modern JavaScript sorting is stable.
 *
 * @param agents - Agent-shaped objects containing id and name.
 * @param lastUsedAgentId - ID to promote ahead of alphabetical ordering.
 * @returns A new sorted array.
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

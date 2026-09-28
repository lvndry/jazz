/**
 * The private network hosts the configuration wizard edits: `network.allowPrivateHosts` in the
 * global config.json. Agents reach a listed host without asking; any other address on this
 * machine or the local network asks for approval, and approving adds it here.
 *
 * `addPrivateHost` and `removePrivateHost` decide the new list; `applyPrivateHosts` writes it (or
 * removes the key when the list is empty), so the wizard and its tests share one rule.
 */

import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import {
  describePrivateHostEntryError,
  MAX_PRIVATE_HOST_ENTRIES,
} from "@jazz/core/utils/private-network";
import { Effect } from "effect";

export const PRIVATE_HOSTS_SETTING = "network.allowPrivateHosts";

export type AddPrivateHostResult =
  | { readonly kind: "added"; readonly hosts: readonly string[] }
  | { readonly kind: "invalid"; readonly message: string };

/** `hosts` with `input` added, or why it cannot be. */
export function addPrivateHost(hosts: readonly string[], input: string): AddPrivateHostResult {
  const entry = input.trim();
  if (entry === "") {
    return {
      kind: "invalid",
      message: "Enter a hostname, *.suffix wildcard, IP address or CIDR block.",
    };
  }
  const problem = describePrivateHostEntryError(entry);
  if (problem !== undefined) {
    return { kind: "invalid", message: problem };
  }
  if (hosts.includes(entry)) {
    return { kind: "invalid", message: `${entry} is already on the list.` };
  }
  if (hosts.length >= MAX_PRIVATE_HOST_ENTRIES) {
    return {
      kind: "invalid",
      message: `The list holds at most ${String(MAX_PRIVATE_HOST_ENTRIES)} entries. Remove one, or use a CIDR block or *.suffix wildcard.`,
    };
  }
  return { kind: "added", hosts: [...hosts, entry] };
}

/** `hosts` without `entry`. */
export function removePrivateHost(hosts: readonly string[], entry: string): readonly string[] {
  return hosts.filter((host) => host !== entry);
}

/** Write `hosts` to the global config; an empty list removes the setting. */
export function applyPrivateHosts(
  configService: AgentConfigService,
  hosts: readonly string[],
): Effect.Effect<void> {
  return configService.set(PRIVATE_HOSTS_SETTING, hosts.length > 0 ? hosts : undefined);
}

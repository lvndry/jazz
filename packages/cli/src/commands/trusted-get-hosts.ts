/**
 * The trusted GET hosts the configuration wizard edits: `network.trustedGetHosts` in the global
 * config.json. A plain GET or HEAD to a listed host never asks for approval, even after the run
 * read untrusted content; every other host still asks.
 *
 * `addTrustedGetHost` and `removeTrustedGetHost` decide the new list; `applyTrustedGetHosts`
 * writes it (or removes the key when the list is empty), so the wizard, the approval prompt and
 * their tests share one rule.
 */

import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import {
  describeTrustedGetHostError,
  MAX_TRUSTED_GET_HOST_ENTRIES,
} from "@jazz/core/utils/private-network";
import { Effect } from "effect";

export const TRUSTED_GET_HOSTS_SETTING = "network.trustedGetHosts";

export type AddTrustedGetHostResult =
  | { readonly kind: "added"; readonly hosts: readonly string[] }
  | { readonly kind: "invalid"; readonly message: string };

/** `hosts` with `input` added, or why it cannot be. */
export function addTrustedGetHost(
  hosts: readonly string[],
  input: string,
): AddTrustedGetHostResult {
  const entry = input.trim().toLowerCase();
  if (entry === "") {
    return { kind: "invalid", message: "Enter a hostname or *.suffix wildcard." };
  }
  const problem = describeTrustedGetHostError(entry);
  if (problem !== undefined) {
    return { kind: "invalid", message: problem };
  }
  if (hosts.includes(entry)) {
    return { kind: "invalid", message: `${entry} is already on the list.` };
  }
  if (hosts.length >= MAX_TRUSTED_GET_HOST_ENTRIES) {
    return {
      kind: "invalid",
      message: `The list holds at most ${String(MAX_TRUSTED_GET_HOST_ENTRIES)} entries. Remove one, or use a *.suffix wildcard.`,
    };
  }
  return { kind: "added", hosts: [...hosts, entry] };
}

/** `hosts` without `entry`. */
export function removeTrustedGetHost(hosts: readonly string[], entry: string): readonly string[] {
  return hosts.filter((host) => host !== entry);
}

/** Write `hosts` to the global config; an empty list removes the setting. */
export function applyTrustedGetHosts(
  configService: Pick<AgentConfigService, "set">,
  hosts: readonly string[],
): Effect.Effect<void> {
  return configService.set(TRUSTED_GET_HOSTS_SETTING, hosts.length > 0 ? hosts : undefined);
}

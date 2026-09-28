/**
 * Private destinations need a person: the approval step for a model-chosen URL that reaches this
 * machine or the local network.
 *
 * `guardedFetch` refuses every private address the global `network.allowPrivateHosts` does not
 * list. Before an egress tool with a `url` runs, the executor asks which private addresses that
 * URL would reach, and a call that reaches an unlisted one is put to a person like any gated call
 * (prompted, parked, or declined when nobody can answer). A person's approval adds those
 * addresses to `network.allowPrivateHosts`, so the next call to them goes through unasked. A
 * `high-risk` or yolo run lets the call through without a prompt and without widening the list.
 * Either way the approved addresses reach the tool as `approvedPrivateAddresses` for that call.
 *
 * Only the URL the model passed is checked here. A redirect or a headless page's subresource that
 * lands on a private address is still refused by `guardedFetch`, whose message tells the model to
 * request that URL directly, which brings it back through this step.
 */

import { Effect } from "effect";
import { egressPolicyForContext, unlistedPrivateAddresses } from "@/core/agent/tools/guarded-fetch";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { AutoApprovePolicy, ToolExecutionContext } from "@/core/types/tools";
import { MAX_PRIVATE_HOST_ENTRIES } from "@/core/utils/private-network";
import { policyApprovesTaintedEgress } from "./egress-taint";

/** The private addresses an egress call's `url` reaches that nothing has allowed yet. */
export function unlistedPrivateAddressesFor(
  egress: boolean,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Effect.Effect<readonly string[], never, AgentConfigService> {
  return Effect.gen(function* () {
    const url = args["url"];
    if (!egress || typeof url !== "string") {
      return [];
    }
    const policy = yield* egressPolicyForContext(context);
    const destinations = yield* Effect.promise(() => unlistedPrivateAddresses(url, policy));
    return [...new Set(destinations.map((destination) => destination.address))];
  });
}

/**
 * Whether a person has to approve reaching `addresses`. The policy tiers that approve egress after
 * untrusted content (`high-risk`, `true`) approve this too, and so does an explicit per-tool
 * allowlist entry.
 */
export function privateDestinationNeedsApproval(
  addresses: readonly string[],
  policy: AutoApprovePolicy | undefined,
  toolAllowlisted: boolean,
): boolean {
  return addresses.length > 0 && !toolAllowlisted && !policyApprovesTaintedEgress(policy);
}

/** The approval text for a call that reaches unlisted private addresses. */
export function privateDestinationApprovalMessage(
  toolName: string,
  args: Record<string, unknown>,
  addresses: readonly string[],
): string {
  const url = typeof args["url"] === "string" ? args["url"] : "a URL";
  const listed = addresses.join(", ");
  return (
    `${toolName} wants to reach ${url}, which is on this machine or your local network ` +
    `(${listed}).\nApproving adds ${listed} to network.allowPrivateHosts in your Jazz config, ` +
    "so later requests there go through without asking."
  );
}

/**
 * Add `addresses` to the global `network.allowPrivateHosts` after a person approved them. A list
 * already at its limit is left as it is; the approved call still runs.
 */
export function rememberPrivateAddresses(
  addresses: readonly string[],
): Effect.Effect<void, never, AgentConfigService | LoggerService> {
  return Effect.gen(function* () {
    if (addresses.length === 0) {
      return;
    }
    const configService = yield* AgentConfigServiceTag;
    const logger = yield* LoggerServiceTag;
    const current = (yield* configService.appConfig).network?.allowPrivateHosts ?? [];
    const merged = [...new Set([...current, ...addresses])];
    if (merged.length === current.length) {
      return;
    }
    if (merged.length > MAX_PRIVATE_HOST_ENTRIES) {
      yield* logger.warn("network.allowPrivateHosts is full; the approved address was not saved", {
        limit: MAX_PRIVATE_HOST_ENTRIES,
      });
      return;
    }
    yield* configService.set("network.allowPrivateHosts", merged);
    yield* logger.info("Added approved private addresses to network.allowPrivateHosts", {
      added: merged.length - current.length,
    });
  });
}

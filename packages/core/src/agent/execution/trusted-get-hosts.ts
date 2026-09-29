/**
 * "Always allow GET to this host": the approval choice that adds a hostname to
 * `network.trustedGetHosts`. The run's own list is updated at once, so the next call in the same
 * run goes through, and the global config is written so later runs do too.
 */

import { Effect } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { LoggerServiceTag, type LoggerService } from "@/core/interfaces/logger";
import type { ToolExecutionContext } from "@/core/types/tools";
import {
  describeTrustedGetHostError,
  MAX_TRUSTED_GET_HOST_ENTRIES,
} from "@/core/utils/private-network";

export function rememberTrustedGetHost(
  host: string,
  context: Pick<ToolExecutionContext, "trustedGetHosts">,
): Effect.Effect<void, never, AgentConfigService | LoggerService> {
  return Effect.gen(function* () {
    if (describeTrustedGetHostError(host) !== undefined) {
      return;
    }
    if (context.trustedGetHosts !== undefined && !context.trustedGetHosts.includes(host)) {
      context.trustedGetHosts.push(host);
    }
    const configService = yield* AgentConfigServiceTag;
    const logger = yield* LoggerServiceTag;
    const current = (yield* configService.appConfig).network?.trustedGetHosts ?? [];
    if (current.includes(host)) {
      return;
    }
    if (current.length >= MAX_TRUSTED_GET_HOST_ENTRIES) {
      yield* logger.warn(
        "network.trustedGetHosts is full; the host was trusted for this run only",
        {
          limit: MAX_TRUSTED_GET_HOST_ENTRIES,
        },
      );
      return;
    }
    yield* configService.set("network.trustedGetHosts", [...current, host]);
    yield* logger.info("Added a host to network.trustedGetHosts", { host });
  });
}

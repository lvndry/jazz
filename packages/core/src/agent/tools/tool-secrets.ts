/**
 * The secret values tool output is redacted against, for the registry and for tools that must
 * redact before they slice, search or cap their own output.
 */

import { Effect, Option } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { collectKnownSecrets, type KnownSecret } from "@/core/secrets/redaction";

/**
 * Every secret Jazz knows: the config service's held secrets (keyring and environment values
 * included) when it provides them, else the resolved app config's secret paths, plus the
 * process's secret-named environment variables. Without a config service in scope, the
 * environment's.
 */
export function toolKnownSecrets(): Effect.Effect<readonly KnownSecret[]> {
  return Effect.gen(function* () {
    const configService = yield* Effect.serviceOption(AgentConfigServiceTag);
    if (Option.isNone(configService)) {
      return collectKnownSecrets(undefined);
    }
    if (configService.value.knownSecrets !== undefined) {
      return yield* configService.value.knownSecrets;
    }
    return collectKnownSecrets(yield* configService.value.appConfig);
  });
}

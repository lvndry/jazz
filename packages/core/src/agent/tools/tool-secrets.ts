/**
 * The secret values tool output is redacted against, for the registry and for tools that must
 * redact before they slice, search or cap their own output.
 */

import { Effect, Option } from "effect";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { collectKnownSecrets, type KnownSecret } from "@/core/secrets/redaction";
import { heldUserSecrets } from "@/core/secrets/user-secrets";

/**
 * Every secret Jazz knows: the config service's held secrets (keyring and environment values
 * included) when it provides them, else the resolved app config's secret paths, plus the
 * process's secret-named environment variables. Without a config service in scope, the
 * environment's. Secrets a person typed into `ask_user_secret` for a run still in progress come
 * first, whatever their length.
 */
export function toolKnownSecrets(): Effect.Effect<readonly KnownSecret[]> {
  return Effect.map(configKnownSecrets(), (known) => {
    const typed = heldUserSecrets();
    return typed.length === 0 ? known : [...typed, ...known];
  });
}

function configKnownSecrets(): Effect.Effect<readonly KnownSecret[]> {
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

import { getConfigValue } from "@jazz/adapters/config";
import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { Effect } from "effect";

export function resolveEditor(): Effect.Effect<string, never, AgentConfigService> {
  return getConfigValue<string | undefined>("editor", undefined).pipe(
    Effect.map(
      (configured) => configured?.trim() || process.env["VISUAL"] || process.env["EDITOR"] || "vi",
    ),
  );
}

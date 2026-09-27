import type { AgentConfigService } from "@jazz/core/interfaces/agent-config";
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import type { AppConfig } from "@jazz/core/types/config";
import { describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";
import { ensureProviderApiKey } from "./provider-api-key";

function setup(answers: readonly (string | undefined)[], config: Partial<AppConfig> = {}) {
  const pending = [...answers];
  const saved: { key: string; value: unknown }[] = [];
  const errors: string[] = [];
  const terminal = {
    log: mock(() => Effect.void),
    warn: mock(() => Effect.void),
    success: mock(() => Effect.void),
    error: mock((message: string) => {
      errors.push(message);
      return Effect.void;
    }),
    ask: mock(() => Effect.succeed(pending.shift())),
  } as unknown as TerminalService;
  const configService = {
    appConfig: Effect.succeed({ llm: {}, ...config } as AppConfig),
    set: mock((key: string, value: unknown) => {
      saved.push({ key, value });
      return Effect.void;
    }),
  } as unknown as AgentConfigService;
  return { terminal, configService, saved, errors };
}

describe("ensureProviderApiKey", () => {
  it("asks again when the provider rejects the pasted key, and saves the one it accepts", async () => {
    const { terminal, configService, saved, errors } = setup(["sk-wrong", "  sk-right\n"]);
    const checkKey = mock(async (_provider: string, apiKey: string) =>
      apiKey === "sk-right" ? ("accepted" as const) : ("rejected" as const),
    );

    const result = await ensureProviderApiKey({
      configService,
      terminal,
      provider: "openai",
      displayName: "OpenAI",
      required: true,
      checkKey,
    });

    expect(result).toBe("saved");
    expect(saved).toEqual([{ key: "llm.openai.api_key", value: "sk-right" }]);
    expect(errors[0]).toContain("rejected this key");
  });

  it("does not check a key for a provider pointed at a custom endpoint", async () => {
    const { terminal, configService, saved } = setup(["sk-proxy"], {
      llm: { openai: { base_url: "http://proxy.local/v1" } },
    } as Partial<AppConfig>);
    const checkKey = mock(async () => "rejected" as const);

    await ensureProviderApiKey({
      configService,
      terminal,
      provider: "openai",
      displayName: "OpenAI",
      required: true,
      checkKey,
    });

    expect(checkKey).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
  });

  it("returns cancelled when the prompt is dismissed", async () => {
    const { terminal, configService, saved } = setup([undefined]);

    const result = await ensureProviderApiKey({
      configService,
      terminal,
      provider: "openai",
      displayName: "OpenAI",
      required: true,
      checkKey: async () => "accepted",
    });

    expect(result).toBe("cancelled");
    expect(saved).toEqual([]);
  });
});

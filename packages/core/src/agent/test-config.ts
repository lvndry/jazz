/**
 * A config service for tests that run a tool reading the app config, holding only `appConfig`.
 */
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import type { AppConfig } from "@/core/types/config";

export function testConfigService(appConfig: Partial<AppConfig> = {}): AgentConfigService {
  return { appConfig: Effect.succeed(appConfig) } as unknown as AgentConfigService;
}

export function testConfigLayer(appConfig: Partial<AppConfig> = {}) {
  return Layer.succeed(AgentConfigServiceTag, testConfigService(appConfig));
}

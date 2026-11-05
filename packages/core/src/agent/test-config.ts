/**
 * A config service for tests that run a tool reading the app config, holding only `appConfig`.
 */
import { Effect, Layer } from "effect";
import { AgentConfigServiceTag, type AgentConfigService } from "@/core/interfaces/agent-config";
import { partialFake } from "@/core/test-support/fakes";
import type { AppConfig } from "@/core/types/config";

export function testConfigService(appConfig: Partial<AppConfig> = {}): AgentConfigService {
  return partialFake<AgentConfigService>({ appConfig: Effect.succeed(appConfig) });
}

export function testConfigLayer(appConfig: Partial<AppConfig> = {}) {
  return Layer.succeed(AgentConfigServiceTag, testConfigService(appConfig));
}

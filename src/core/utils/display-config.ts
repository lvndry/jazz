import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { AppConfig } from "@/core/types/config";
import type { DisplayConfig } from "@/core/types/output";

/**
 * Resolve display configuration from app config with defaults.
 */
export function resolveDisplayConfig(appConfig: AppConfig): DisplayConfig {
  return {
    showThinking: appConfig.output?.showThinking ?? DEFAULT_DISPLAY_CONFIG.showThinking,
    showToolExecution:
      appConfig.output?.showToolExecution ?? DEFAULT_DISPLAY_CONFIG.showToolExecution,
    mode: appConfig.output?.mode ?? DEFAULT_DISPLAY_CONFIG.mode,
    colorProfile: appConfig.output?.colorProfile,
  };
}

import { DEFAULT_DISPLAY_CONFIG } from "@/core/agent/types";
import type { AppConfig } from "@/core/types/config";
import type { DisplayConfig, OutputMode } from "@/core/types/output";

const VALID_OUTPUT_MODES: readonly string[] = ["rendered", "hybrid", "raw", "quiet"];

/**
 * Resolve display configuration from app config with defaults.
 *
 * Priority for output mode (highest to lowest):
 * 1. JAZZ_OUTPUT_MODE environment variable (e.g. `JAZZ_OUTPUT_MODE=raw`)
 * 2. App config file (`output.mode`)
 * 3. Default ("hybrid")
 */
export function resolveDisplayConfig(appConfig: AppConfig): DisplayConfig {
  const envMode = process.env["JAZZ_OUTPUT_MODE"];
  const resolvedEnvMode =
    envMode && VALID_OUTPUT_MODES.includes(envMode) ? (envMode as OutputMode) : undefined;

  return {
    showThinking: appConfig.output?.showThinking ?? DEFAULT_DISPLAY_CONFIG.showThinking,
    showToolExecution:
      appConfig.output?.showToolExecution ?? DEFAULT_DISPLAY_CONFIG.showToolExecution,
    mode: resolvedEnvMode ?? appConfig.output?.mode ?? DEFAULT_DISPLAY_CONFIG.mode,
    colorProfile: appConfig.output?.colorProfile,
  };
}

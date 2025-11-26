import type { AppConfig } from "../types";

/**
 * Stream detection utility
 * Determines if streaming should be enabled based on:
 * 1. Explicit CLI flags (--stream, --no-stream)
 * 2. Environment variables (NO_COLOR, CI)
 * 3. TTY status (stdout.isTTY)
 * 4. User configuration
 */

/**
 * Options to override stream detection
 */
export interface StreamDetectionOptions {
  /**
   * Override streaming behavior.
   * - `true`: Force streaming on
   * - `false`: Force streaming off
   * - `undefined`: Use auto-detection (default)
   */
  stream?: boolean;
}

/**
 * Result of stream detection
 */
export interface StreamDetection {
  /**
   * Should streaming be enabled?
   */
  shouldStream: boolean;

  /**
   * Reason for the decision (for debugging)
   */
  reason: string;
}

/**
 * Determine if streaming should be enabled
 * Priority order:
 * 1. Explicit stream override (from CLI flags)
 * 2. Config file (enabled: true/false/auto)
 * 3. Environment variables (CI=true, NO_COLOR=1)
 * 4. Auto-detection (TTY status)
 */
export function shouldEnableStreaming(
  appConfig: AppConfig,
  options: StreamDetectionOptions = {},
): StreamDetection {
  // Priority 1: Explicit stream override (from CLI flags)
  if (options.stream !== undefined) {
    return {
      shouldStream: options.stream,
      reason: options.stream
        ? "Enabled via --stream CLI flag"
        : "Disabled via --no-stream CLI flag",
    };
  }

  // Priority 2: Config file
  const configStreaming = appConfig.output?.streaming?.enabled;

  if (configStreaming === false) {
    return {
      shouldStream: false,
      reason: "Disabled in config file (output.streaming.enabled = false)",
    };
  }

  if (configStreaming === true) {
    return {
      shouldStream: true,
      reason: "Enabled in config file (output.streaming.enabled = true)",
    };
  }

  // Priority 3: Environment variables

  // Check for CI environment (disable streaming in CI by default)
  if (process.env["CI"] === "true" || process.env["CI"] === "1") {
    return {
      shouldStream: false,
      reason: "Disabled in CI environment (CI=true)",
    };
  }

  // Check for NO_COLOR (often indicates non-interactive terminal)
  if (process.env["NO_COLOR"] === "true" || process.env["NO_COLOR"] === "1") {
    return {
      shouldStream: false,
      reason: "Disabled due to NO_COLOR environment variable",
    };
  }

  // Priority 4: Auto-detection based on TTY
  // configStreaming is "auto" or undefined at this point
  const isTTY = process.stdout.isTTY ?? false;

  if (isTTY) {
    return {
      shouldStream: true,
      reason: "Auto-enabled: stdout is a TTY (interactive terminal)",
    };
  } else {
    return {
      shouldStream: false,
      reason: "Auto-disabled: stdout is not a TTY (piped/redirected)",
    };
  }
}

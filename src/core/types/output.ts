/**
 * Output/display configuration and rendering types
 */

import type { StreamingConfig } from "./streaming";

/**
 * Output mode controls what content is displayed and how it is formatted
 */
export type OutputMode = "markdown" | "json" | "raw";

/**
 * Color profile for terminal output
 */
export type ColorProfile = "full" | "basic" | "none";

/**
 * Theme configuration for rendering output
 */
export interface RenderTheme {
  readonly colors: {
    readonly thinking: (text: string) => string;
    readonly thinkingContent: (text: string) => string;
    readonly toolName: (text: string) => string;
    readonly toolArgs: (text: string) => string;
    readonly success: (text: string) => string;
    readonly error: (text: string) => string;
    readonly warning: (text: string) => string;
    readonly info: (text: string) => string;
    readonly dim: (text: string) => string;
    readonly highlight: (text: string) => string;
    readonly agentName: (text: string) => string;
  };
  readonly icons: {
    readonly thinking: string;
    readonly tool: string;
    readonly success: string;
    readonly error: string;
    readonly warning: string;
    readonly info: string;
  };
  readonly separatorWidth: number;
  readonly separatorChar: string;
}

/**
 * Output/display configuration for CLI and terminal rendering
 * These settings apply to both streaming and non-streaming modes
 */
export interface OutputConfig {
  /**
   * Show reasoning/thinking process for models that support it
   * (e.g., OpenAI o1, Claude extended thinking, DeepSeek R1)
   * Default: true
   */
  readonly showThinking?: boolean;

  /**
   * Show visual indicators for tool execution
   * Default: true
   */
  readonly showToolExecution?: boolean;

  /**
   * Output mode
   * - "markdown": Rich, styled markdown output with colors (default)
   * - "json": Structured JSON for programmatic consumption
   * - "raw": Plain text stream without markdown formatting
   * Default: "markdown"
   */
  readonly mode?: OutputMode;

  /**
   * Color profile for terminal output
   * - "full": Full color support with emojis
   * - "basic": 16 colors without emojis
   * - "none": No colors (plain text)
   * Default: auto-detect based on terminal capabilities
   */
  readonly colorProfile?: ColorProfile;

  /**
   * Show performance metrics (first token latency, tokens/sec, duration)
   * Useful for debugging and monitoring performance
   * Default: true
   */
  readonly showMetrics?: boolean;

  /**
   * Streaming-specific configuration
   */
  readonly streaming?: StreamingConfig;
}

/**
 * Display configuration for rendering output
 * This is a core type that can be used by presentation services
 */
export interface DisplayConfig {
  readonly showThinking: boolean;
  readonly showToolExecution: boolean;
  readonly mode: OutputMode;
  readonly colorProfile?: ColorProfile | undefined; // Auto-detect if not specified
}

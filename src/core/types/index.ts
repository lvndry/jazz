/**
 * Core types and interfaces
 */

// Agent Types
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly model: `${string}/${string}`;
  readonly config: AgentConfig;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentConfig {
  readonly environment?: Record<string, string>;
  readonly agentType: string;
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly tools?: readonly string[];
}

// Configuration Types
export interface AppConfig {
  readonly storage: StorageConfig;
  readonly logging: LoggingConfig;
  readonly google?: GoogleConfig;
  readonly llm?: LLMConfig;
  readonly linkup?: LinkupConfig;
  readonly exa?: ExaConfig;
  readonly output?: OutputConfig;
}

export type StorageConfig =
  | {
      readonly type: "file";
      readonly path: string;
    }
  | {
      readonly type: "database";
      readonly connectionString: string;
    };

export interface LoggingConfig {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly format: "json" | "pretty";
  readonly output: "console" | "file" | "both";
  readonly filePath?: string;
  /**
   * Show performance metrics (first token latency, tokens/sec, duration)
   * Useful for debugging and monitoring performance
   * Default: false (enable with "debug" level or explicitly)
   */
  readonly showMetrics?: boolean;
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface LLMProviderConfig {
  readonly api_key: string;
}

export interface XAIProviderConfig {
  readonly api_key: string;
}

export interface DeepSeekProviderConfig {
  readonly api_key: string;
}

export interface OllamaProviderConfig {
  readonly api_key?: string;
}

export interface LLMConfig {
  readonly openai?: LLMProviderConfig;
  readonly anthropic?: LLMProviderConfig;
  readonly google?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly xai?: XAIProviderConfig;
  readonly deepseek?: DeepSeekProviderConfig;
  readonly ollama?: OllamaProviderConfig;
  readonly openrouter?: LLMProviderConfig;
}

export interface LinkupConfig {
  readonly api_key: string;
}

export interface ExaConfig {
  readonly api_key: string;
}

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
   * Streaming-specific configuration
   */
  readonly streaming?: StreamingConfig;
}

/**
 * Streaming configuration - controls HOW content is streamed
 * All fields optional with sensible defaults
 */
export interface StreamingConfig {
  /**
   * Enable streaming mode
   * - true: Always stream
   * - false: Never stream
   * - "auto": Auto-detect based on TTY (default)
   */
  readonly enabled?: boolean | "auto";

  /**
   * Text buffer delay in milliseconds
   * Batches small chunks for smoother rendering
   * Only applies when streaming is enabled
   * Default: 50
   */
  readonly textBufferMs?: number;
}

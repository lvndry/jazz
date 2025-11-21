import { Schema } from "effect";

/**
 * Core types and interfaces
 */


// Agent Types
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly config: AgentConfig;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AgentConfig {
  readonly tasks: readonly Task[];
  readonly schedule?: Schedule;
  retryPolicy?: RetryPolicy;
  timeout?: number;
  readonly environment?: Record<string, string>;
  readonly agentType: string;
  readonly llmProvider: string;
  readonly llmModel: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high";
  readonly tools?: readonly string[];
}

export type AgentStatus = "idle" | "running" | "paused" | "error" | "completed";

// Task Types
export interface Task {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: TaskType;
  readonly config: TaskConfig;
  readonly dependencies?: readonly string[];
  readonly retryCount?: number;
  readonly maxRetries?: number;
}

export type TaskType = "command" | "script" | "api" | "file" | "webhook" | "custom" | "gmail";

export type GmailOperation = "list_emails" | "get_email" | "send_email" | "search_emails";

export interface TaskConfig {
  readonly command?: string;
  readonly script?: string;
  readonly url?: string;
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly filePath?: string;
  readonly workingDirectory?: string;
  readonly environment?: Record<string, string>;
  readonly gmailOperation?: GmailOperation;
  readonly gmailQuery?: string;
  readonly gmailMaxResults?: number;
  readonly emailId?: string;
  readonly to?: string[];
  readonly subject?: string;
  readonly cc?: string[];
  readonly bcc?: string[];
}

// Automation Types
export interface Automation {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly agents: readonly string[];
  readonly triggers: readonly Trigger[];
  readonly status: AutomationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type AutomationStatus = "active" | "inactive" | "paused" | "error";

export interface Trigger {
  readonly id: string;
  readonly type: TriggerType;
  readonly config: TriggerConfig;
  readonly enabled: boolean;
}

export type TriggerType = "schedule" | "file" | "webhook" | "manual" | "event";

export interface TriggerConfig {
  readonly cron?: string;
  readonly interval?: number;
  readonly filePath?: string;
  readonly event?: string;
  readonly conditions?: readonly Condition[];
}

export interface Condition {
  readonly field: string;
  readonly operator:
    | "equals"
    | "not_equals"
    | "contains"
    | "not_contains"
    | "greater_than"
    | "less_than";
  readonly value: unknown;
}

// Schedule Types
export interface Schedule {
  readonly type: "cron" | "interval" | "once";
  readonly value: string | number;
  readonly timezone?: string;
  readonly enabled: boolean;
}

// Retry Policy
export interface RetryPolicy {
  readonly maxRetries: number;
  readonly backoff: "linear" | "exponential" | "fixed";
  readonly delay: number;
  readonly maxDelay?: number;
}

// Result Types
export interface TaskResult {
  readonly taskId: string;
  readonly status: "success" | "failure" | "skipped";
  readonly output?: string;
  readonly error?: string;
  readonly duration: number;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentResult {
  readonly agentId: string;
  readonly status: "success" | "failure" | "partial";
  readonly taskResults: readonly TaskResult[];
  readonly duration: number;
  readonly timestamp: Date;
  readonly metadata?: Record<string, unknown>;
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

export interface RateLimitConfig {
  readonly requests: number;
  readonly window: number;
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

export interface LLMConfig {
  readonly openai?: LLMProviderConfig;
  readonly anthropic?: LLMProviderConfig;
  readonly google?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly xai?: XAIProviderConfig;
  readonly deepseek?: DeepSeekProviderConfig;
  readonly contextManagement?: ContextManagementConfig;
}

export interface ContextManagementConfig {
  readonly summarizationThreshold?: number; // Percentage of context window (0.0-1.0)
  readonly targetTokensRatio?: number; // Target tokens as ratio of max context (0.0-1.0)
  readonly aggressiveThreshold?: number; // Aggressive summarization threshold (0.0-1.0)
  readonly preserveRecentMessages?: number; // Number of recent messages to always keep
  readonly maxRecentTokens?: number; // Maximum tokens to preserve in recent messages
  readonly enableProactiveSummarization?: boolean; // Whether to summarize proactively
  readonly summarizeToolResults?: boolean; // Whether to summarize large tool call results
}

export interface LinkupConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeout?: number;
}

export interface ExaConfig {
  readonly apiKey: string;
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

export const TaskSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  type: Schema.Literal("command", "script", "api", "file", "webhook", "custom", "gmail"),
  config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  dependencies: Schema.optional(Schema.Array(Schema.String)),
  retryCount: Schema.optional(Schema.Number),
  maxRetries: Schema.optional(Schema.Number),
});

export const AutomationSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  agents: Schema.Array(Schema.String),
  triggers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.Literal("schedule", "file", "webhook", "manual", "event"),
      config: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      enabled: Schema.Boolean,
    }),
  ),
  status: Schema.Literal("active", "inactive", "paused", "error"),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
});

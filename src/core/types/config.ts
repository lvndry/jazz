/**
 * Application configuration types
 */

import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import type { OutputConfig } from "./output";

export interface AppConfig {
  readonly storage: StorageConfig;
  readonly logging: LoggingConfig;
  readonly llm?: LLMConfig;
  readonly web_search?: WebSearchConfig;
  readonly output?: OutputConfig;
  /** Runtime merged view: full MCPServerConfig objects from .agents/mcp.json + overrides. */
  readonly mcpServers?: Record<string, MCPServerConfig>;
  readonly notifications?: NotificationsConfig;
  readonly autoApprovedCommands?: readonly string[];
  readonly telemetry?: TelemetryConfig;
  /** Maximum number of retries for transient LLM API failures. Defaults to 3. */
  readonly maxRetries?: number;
  /** Sub-agent nesting levels allowed. Defaults to 3; 0 disables delegation. */
  readonly maxSubagentDepth?: number;
  /** Iteration budget for a top-level run. Defaults to 100; --max-iterations wins. */
  readonly maxIterations?: number;
  /** Iteration budget for a sub-agent run. Defaults to 30. */
  readonly maxSubagentIterations?: number;
  readonly context?: ContextConfig;
}

export interface ContextConfig {
  /**
   * Fraction of the context budget at which the model is warned the window is
   * filling up. Defaults to 0.7. Must be below `compactThresholdRatio`.
   */
  readonly warnThresholdRatio?: number;

  /**
   * Fraction of the context budget at which history is compacted automatically.
   * Defaults to 0.8. Must be below the 0.95 trim ratio.
   */
  readonly compactThresholdRatio?: number;
}

export interface NotificationsConfig {
  readonly enabled?: boolean;
  readonly sound?: boolean;
}

export interface TelemetryConfig {
  /** Whether telemetry collection is enabled. Defaults to true. */
  readonly enabled?: boolean;
  /** Directory path for telemetry data storage. Defaults to .jazz/telemetry. */
  readonly storagePath?: string;
  /** Maximum number of events to buffer in memory before flushing. Defaults to 100. */
  readonly bufferSize?: number;
  /** Interval in milliseconds between automatic flushes. Defaults to 30000 (30s). */
  readonly flushIntervalMs?: number;
  /** Maximum number of days to retain telemetry data. Defaults to 90. */
  readonly retentionDays?: number;
  /** Export events to an OpenTelemetry-compatible collector. Off unless an endpoint is set. */
  readonly otlp?: OtlpTelemetryConfig;
}

/**
 * OTLP/HTTP export settings.
 *
 * Every field falls back to the corresponding `OTEL_*` environment variable, so
 * a Jazz process inherits an already-configured collector without touching
 * config.json.
 */
export interface OtlpTelemetryConfig {
  /**
   * Explicit opt-out. Export is enabled by the presence of an endpoint; set
   * this to false to keep the endpoint configured but stop sending.
   */
  readonly enabled?: boolean;
  /**
   * Signals to export. Defaults to `["traces"]`: spans are what turns a run
   * into a waterfall, and what LLM-observability backends accept — Langfuse
   * ingests OTLP traces and not logs.
   */
  readonly signals?: readonly ("traces" | "logs")[];
  /** Collector base URL, e.g. `http://localhost:4318`. Env: OTEL_EXPORTER_OTLP_ENDPOINT. */
  readonly endpoint?: string;
  /**
   * Full traces URL including path, overriding `endpoint`. Needed by backends
   * that do not serve OTLP at `<base>/v1/traces`.
   * Env: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT.
   */
  readonly tracesEndpoint?: string;
  /**
   * Full logs URL including path, overriding `endpoint`.
   * Env: OTEL_EXPORTER_OTLP_LOGS_ENDPOINT.
   */
  readonly logsEndpoint?: string;
  /** Extra HTTP headers, typically auth. Env: OTEL_EXPORTER_OTLP_HEADERS. */
  readonly headers?: Readonly<Record<string, string>>;
  /** `service.name` on exported records. Defaults to "jazz". Env: OTEL_SERVICE_NAME. */
  readonly serviceName?: string;
  /**
   * Include prompt, completion, and tool argument text in exported events.
   * Defaults to false: enabling it sends user content to the configured
   * endpoint.
   */
  readonly captureContent?: boolean;
  /** Per-request timeout in milliseconds. Defaults to 10000. */
  readonly timeoutMs?: number;
}

/**
 * MCP server override stored in ~/.jazz/config.json or ./.jazz/config.json.
 * Only contains Jazz-specific metadata — full server definitions
 * live in ~/.agents/mcp.json (global) or .agents/mcp.json (project-local).
 */
export interface MCPServerOverride {
  readonly enabled?: boolean;
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
  readonly format: "json" | "plain";
}

export interface LLMProviderConfig {
  readonly api_key: string;
}

export interface OllamaProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;
  /** Ollama `keep_alive` (e.g. "30m", "-1"); how long the model stays loaded. Unset = Ollama default. */
  readonly keep_alive?: string;
}

export interface LlamaCppProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;
}

export interface LLMConfig {
  readonly ai_gateway?: LLMProviderConfig;
  readonly alibaba?: LLMProviderConfig;
  readonly anthropic?: LLMProviderConfig;
  readonly cerebras?: LLMProviderConfig;
  readonly deepseek?: LLMProviderConfig;
  readonly fireworks?: LLMProviderConfig;
  readonly gemini?: LLMProviderConfig;
  readonly groq?: LLMProviderConfig;
  readonly llamacpp?: LlamaCppProviderConfig;
  readonly minimax?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly moonshotai?: LLMProviderConfig;
  readonly ollama?: OllamaProviderConfig;
  readonly openai?: LLMProviderConfig;
  readonly openrouter?: LLMProviderConfig;
  readonly togetherai?: LLMProviderConfig;
  readonly xai?: LLMProviderConfig;
  readonly zhipuai?: LLMProviderConfig;
}

export type WebSearchProviderName =
  "exa" | "parallel" | "tavily" | "brave" | "perplexity" | "linkup";

export interface WebSearchProviderConfig {
  readonly api_key: string;
}

export interface WebSearchConfig {
  readonly exa?: WebSearchProviderConfig;
  readonly parallel?: WebSearchProviderConfig;
  readonly tavily?: WebSearchProviderConfig;
  readonly brave?: WebSearchProviderConfig;
  readonly perplexity?: WebSearchProviderConfig;
  readonly linkup?: WebSearchProviderConfig;
  readonly provider?: WebSearchProviderName;
}

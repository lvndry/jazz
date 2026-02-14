/**
 * Application configuration types
 */

import type { OutputConfig } from "./output";

export interface AppConfig {
  readonly storage: StorageConfig;
  readonly logging: LoggingConfig;
  readonly google?: GoogleConfig;
  readonly llm?: LLMConfig;
  readonly web_search?: WebSearchConfig;
  readonly output?: OutputConfig;
  readonly mcpServers?: Record<string, MCPServerConfig>;
  readonly notifications?: NotificationsConfig;
  readonly autoApprovedCommands?: readonly string[];
  readonly telemetry?: TelemetryConfig;
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
}

export interface MCPServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly enabled?: boolean;
  readonly inputs?: Record<string, string>;
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
  readonly format: "json" | "plain" | "toon";
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface LLMProviderConfig {
  readonly api_key: string;
}

export interface OllamaProviderConfig {
  readonly api_key?: string;
}

export interface LLMConfig {
  readonly ai_gateway?: LLMProviderConfig;
  readonly alibaba?: LLMProviderConfig;
  readonly anthropic?: LLMProviderConfig;
  readonly cerebras?: LLMProviderConfig;
  readonly deepseek?: LLMProviderConfig;
  readonly fireworks?: LLMProviderConfig;
  readonly google?: LLMProviderConfig;
  readonly groq?: LLMProviderConfig;
  readonly minimax?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly moonshotai?: LLMProviderConfig;
  readonly ollama?: OllamaProviderConfig;
  readonly openai?: LLMProviderConfig;
  readonly openrouter?: LLMProviderConfig;
  readonly togetherai?: LLMProviderConfig;
  readonly xai?: LLMProviderConfig;
}

export interface WebSearchProviderConfig {
  readonly api_key: string;
}

export interface WebSearchConfig {
  readonly exa?: WebSearchProviderConfig;
  readonly parallel?: WebSearchProviderConfig;
  readonly tavily?: WebSearchProviderConfig;
  readonly brave?: WebSearchProviderConfig;
  readonly perplexity?: WebSearchProviderConfig;
  readonly provider?: "exa" | "parallel" | "tavily" | "brave" | "perplexity";
}

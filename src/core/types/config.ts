/**
 * Application configuration types
 */

import type { OutputConfig } from "./output";

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

export interface OllamaProviderConfig {
  readonly api_key?: string;
}

export interface LLMConfig {
  readonly openai?: LLMProviderConfig;
  readonly anthropic?: LLMProviderConfig;
  readonly google?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly xai?: LLMProviderConfig;
  readonly deepseek?: LLMProviderConfig;
  readonly ollama?: OllamaProviderConfig;
}

export interface LinkupConfig {
  readonly api_key: string;
}

export interface ExaConfig {
  readonly api_key: string;
}

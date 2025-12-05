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
  readonly openrouter?: LLMProviderConfig;
  readonly ai_gateway?: LLMProviderConfig;
  readonly groq?: LLMProviderConfig;
}

export interface WebSearchProviderConfig {
  readonly api_key: string;
}

export interface WebSearchConfig {
  readonly linkup?: WebSearchProviderConfig;
  readonly exa?: WebSearchProviderConfig;
  readonly parallel?: WebSearchProviderConfig;
  readonly priority_order?: readonly string[]; // e.g., ["parallel", "exa", "linkup"]
}

/**
 * Application configuration types
 */

import type { ProviderName } from "@/core/constants/models";
import type { MCPServerConfig } from "@/core/interfaces/mcp-server";
import type { HostProfile } from "./host";
import type { ModelCapabilityOverride } from "./model-capabilities";
import type { NotifyConfig } from "./notify";
import type { OutputConfig } from "./output";
import type { PeerConfig } from "./peer";
import type { WebhookConfig } from "./webhook";

export type SchedulerMode = "auto" | "in-process";

export interface SchedulerConfig {
  readonly mode?: SchedulerMode;
}

/**
 * Network reach for the URLs a model chooses (`http_request`, `web_fetch`, `read_pdf`, headless
 * renders), for every agent. Read from the global config file only: a project config cannot
 * widen it.
 *
 * Public internet hosts are always reachable. Loopback, private, link-local and other
 * non-public addresses are refused unless listed here.
 */
export interface NetworkConfig {
  /**
   * Private hosts agents may reach. Each entry is a hostname (`homeassistant.local`), a
   * `*.suffix` wildcard (`*.lan`), an IP address (`192.168.1.10`, `::1`) or a CIDR block
   * (`192.168.1.0/24`). A hostname entry allows whatever that name resolves to; an address or
   * block entry allows those addresses behind any name. At most 64 entries.
   */
  readonly allowPrivateHosts?: readonly string[];
}

export interface AppConfig {
  readonly storage: StorageConfig;
  readonly logging: LoggingConfig;
  readonly llm?: LLMConfig;
  readonly web_search?: WebSearchConfig;
  readonly network?: NetworkConfig;
  readonly output?: OutputConfig;
  /** Runtime merged view: full MCPServerConfig objects from .agents/mcp.json + overrides. */
  readonly mcpServers?: Record<string, MCPServerConfig>;
  readonly notifications?: NotificationsConfig;
  readonly autoApprovedCommands?: readonly string[];
  readonly telemetry?: TelemetryConfig;
  /** Maximum number of retries for transient LLM API failures. Defaults to 3. */
  readonly maxRetries?: number;
  /** Editor command for `jazz persona edit` and `jazz mcp add`, e.g. "code --wait". Defaults to $VISUAL, then $EDITOR, then vi. */
  readonly editor?: string;
  /** Sub-agent nesting levels allowed. Defaults to 3; 0 disables delegation. */
  readonly maxSubagentDepth?: number;
  /** Iteration budget for a top-level run. Defaults to 100; --max-iterations wins. */
  readonly maxIterations?: number;
  /** Iteration budget for a sub-agent run. Defaults to 30. */
  readonly maxSubagentIterations?: number;
  /**
   * Per-run spend ceiling in USD (own tokens plus any sub-agent spend), checked between
   * iterations. Unset means uncapped — there is no default ceiling. `--max-cost-usd` wins.
   */
  readonly maxCostUSD?: number;
  /**
   * Per-run token ceiling (own prompt + completion tokens), checked between iterations.
   * Unset means uncapped. `--max-tokens` wins. Unlike `maxCostUSD`, needs no pricing
   * metadata, so it still enforces on an unpriced/local model.
   */
  readonly maxTokens?: number;
  /**
   * Wall-clock spend budget in ms, checked between iterations, with pressure nudges to the
   * agent at 50/80/90% elapsed. Unset means uncapped. `--max-duration-ms` wins.
   */
  readonly maxDurationMs?: number;
  readonly context?: ContextConfig;
  readonly history?: HistoryConfig;
  /**
   * Per-agent total size cap for the workspace scratch directory, in bytes.
   * Defaults to 1GB (`DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT`).
   */
  readonly workspaceMaxTotalBytesPerAgent?: number;
  /**
   * Scheduler selection for unattended workflow execution.
   *
   * Leave unset (or "auto") to use the platform scheduler: launchd on macOS,
   * cron on Linux. Set to "in-process" to let `jazz daemon` own the ticker on
   * an always-on host.
   */
  readonly scheduler?: SchedulerConfig;

  /**
   * Other people's agents this machine will talk to.
   *
   * Explicit and never discovered: no request from an unlisted origin is served, whatever
   * it presents. Discovery can describe a peer somebody already decided to add; it must
   * never be the thing that creates one.
   */
  readonly peers?: readonly PeerConfig[];
  /** Operator-registered SSH destinations for detached conversations. */
  readonly hosts?: readonly HostProfile[];
  /**
   * Webhook doors onto specific agents. Unlike a peer, a webhook runs a fixed prompt template
   * rather than answering an open-ended question — a narrower surface, authenticated the same
   * way (a bearer token in the keyring, never in this file).
   */
  readonly webhooks?: readonly WebhookConfig[];
  /** Where Jazz tells you what happened while you were away: see `NotifyConfig`. */
  readonly notify?: NotifyConfig;
  /** What `jazz daemon` may spend and how it reaches you. */
  readonly daemon?: DaemonConfig;
  /** How the interactive interface looks. */
  readonly ui?: UiConfig;
}

/** Whether the interface's ground is the terminal's own background or the theme's. */
export type UiCanvasMode = "inherit" | "painted";

export interface UiConfig {
  /**
   * The theme: a name (`jazz`, `catppuccin`, `system`, or a file in `$JAZZ_HOME/themes`), or
   * `name:dark` / `name:light` to pin a variant. `/theme` writes it. `JAZZ_THEME` wins.
   */
  readonly theme?: string;
  /**
   * `inherit` (the default) leaves the terminal's own background showing and paints only
   * panels and code; `painted` paints every cell with the theme's background.
   */
  readonly canvas?: UiCanvasMode;
}

/** A dollar cap per local day and per local month. Either may be unset (unlimited). */
export interface CostCaps {
  readonly dailyCostUSD?: number;
  readonly monthlyCostUSD?: number;
}

/**
 * Spend caps for work nobody is watching: runs started by the daemon, `jazz run`, workflows,
 * webhooks, peers, goals, loops and triggers. Counted from the spend ledger; your chat turns
 * never count. Every cap is unset, meaning unlimited, until you set it.
 *
 * Reaching a machine-wide daily cap pauses the daemon's own work until midnight (or
 * `jazz daemon resume`); any reached cap refuses unattended runs it covers, before they start.
 * Unpriced runs add nothing to a dollar cap's spend, and a daily dollar cap with an unpriced
 * run today blocks as if reached, since its spend cannot be verified.
 */
export interface DaemonConfig extends CostCaps {
  /** Most prompt and completion tokens unattended runs may spend per day, across all of them. */
  readonly dailyTokens?: number;
  /** Caps on goal cycles and loop runs together. */
  readonly goals?: CostCaps;
  /** Caps on one agent's unattended runs, keyed by agent name or id. */
  readonly agents?: Readonly<Record<string, CostCaps>>;
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

/**
 * How a desktop notification reaches a terminal that shows notifications itself: `auto` picks the
 * escape sequence from the environment, `osc99`, `osc777` or `osc9` forces one, `off` always uses
 * the OS notifier.
 */
export type TerminalNotificationSetting = "auto" | "osc99" | "osc777" | "osc9" | "off";

export interface NotificationsConfig {
  readonly enabled?: boolean;
  readonly sound?: boolean;
  /** Defaults to `auto`. `JAZZ_NOTIFICATIONS_TERMINAL` wins over it. */
  readonly terminal?: TerminalNotificationSetting;
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
  readonly signals?: readonly ("traces" | "logs" | "metrics")[];
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
  /** Full metrics URL including path. Env: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT. */
  readonly metricsEndpoint?: string;
  /** Extra HTTP headers, typically auth. Env: OTEL_EXPORTER_OTLP_HEADERS. */
  readonly headers?: Readonly<Record<string, string>>;
  /** `service.name` on exported records. Defaults to "jazz". Env: OTEL_SERVICE_NAME. */
  readonly serviceName?: string;
  /**
   * Resource attributes attached to every exported record beyond `service.name`,
   * such as `deployment.environment` so a shared collector can filter and route
   * this process's telemetry. Env: OTEL_RESOURCE_ATTRIBUTES.
   */
  readonly resourceAttributes?: Readonly<Record<string, string>>;
  /** Per-request timeout in milliseconds. Defaults to 10000. */
  readonly timeoutMs?: number;
  /** Maximum disk space used by pending OTLP traces and logs. Defaults to 32 MiB. */
  readonly maxQueuedBytes?: number;
  /** Maximum age of pending OTLP traces and logs in milliseconds. Defaults to seven days. */
  readonly maxQueueAgeMs?: number;
  /** Metric export interval in milliseconds. Defaults to 30 seconds. */
  readonly metricExportIntervalMs?: number;
}

/**
 * MCP server override stored in ~/.jazz/config.json or ./.jazz/config.json.
 * Only contains Jazz-specific metadata — full server definitions
 * live in ~/.agents/mcp.json (global) or .agents/mcp.json (project-local).
 */
export interface MCPServerOverride {
  readonly enabled?: boolean;
  /**
   * Whether the user vouches for this server. Owned by Jazz rather than
   * mcp.json, because it is a statement about the user's trust, not part of
   * the server's own definition.
   */
  readonly trusted?: boolean;
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
  /** Days a file in the logs directory is kept after its last write. Defaults to 14. */
  readonly retentionDays?: number;
  /** Size cap for the whole logs directory, in megabytes; oldest files go first. Defaults to 200. */
  readonly maxTotalSizeMB?: number;
}

export interface HistoryConfig {
  /**
   * Conversations each agent keeps in its live history. Older ones are archived (compressed
   * under `history/archive/`), never deleted, and a conversation a goal, loop or run still
   * uses is never archived. Defaults to 100.
   */
  readonly maxConversationsPerAgent?: number;
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

/** Connection settings for a user-operated vLLM OpenAI-compatible server. */
export interface VllmProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;
}

/** Connection settings for a user-operated SGLang OpenAI-compatible server. */
export interface SglangProviderConfig {
  readonly api_key?: string;
  readonly base_url?: string;
}

export interface AnthropicProviderConfig {
  readonly api_key?: string;
  /**
   * Required alongside an identity-linked API key (one tied to a Console user
   * rather than a workspace); Anthropic's API otherwise rejects the request.
   */
  readonly workspace_id?: string;
}

/**
 * Non-secret record of a ChatGPT subscription sign-in. The OAuth tokens live in the
 * keyring; this is what marks the provider as configured without a keyring read.
 */
export interface ChatGPTProviderConfig {
  readonly account_id?: string;
  /** ChatGPT plan reported by the sign-in token, e.g. "plus" or "pro". */
  readonly plan?: string;
}

export interface LLMConfig {
  /**
   * How long a provider stream may stay silent before jazz abandons it as dead,
   * in milliseconds. Defaults to 120000, or JAZZ_STREAM_IDLE_TIMEOUT_MS when
   * set. Local providers loading weights from disk on a cold start can
   * legitimately exceed the default before their first streamed part.
   */
  readonly streamIdleTimeoutMs?: number;
  /**
   * Local corrections for provider/model controls models.dev cannot describe.
   *
   * Keys are exact provider-facing model IDs. Values select only Jazz-owned,
   * schema-validated transports; they cannot inject arbitrary request options.
   */
  readonly capabilityOverrides?: Partial<
    Record<ProviderName, Readonly<Record<string, ModelCapabilityOverride>>>
  >;
  readonly ai_gateway?: LLMProviderConfig;
  readonly alibaba?: LLMProviderConfig;
  readonly anthropic?: AnthropicProviderConfig;
  readonly cerebras?: LLMProviderConfig;
  readonly chatgpt?: ChatGPTProviderConfig;
  readonly deepseek?: LLMProviderConfig;
  readonly fireworks?: LLMProviderConfig;
  readonly gemini?: LLMProviderConfig;
  readonly groq?: LLMProviderConfig;
  readonly llamacpp?: LlamaCppProviderConfig;
  readonly minimax?: LLMProviderConfig;
  readonly mistral?: LLMProviderConfig;
  readonly moonshotai?: LLMProviderConfig;
  readonly nvidia?: LLMProviderConfig;
  readonly ollama?: OllamaProviderConfig;
  readonly openai?: LLMProviderConfig;
  readonly openrouter?: LLMProviderConfig;
  readonly orcarouter?: LLMProviderConfig;
  readonly togetherai?: LLMProviderConfig;
  readonly sglang?: SglangProviderConfig;
  readonly vllm?: VllmProviderConfig;
  readonly xai?: LLMProviderConfig;
  readonly zhipuai?: LLMProviderConfig;
}

export const WEB_SEARCH_PROVIDERS = [
  "exa",
  "parallel",
  "tavily",
  "brave",
  "perplexity",
  "linkup",
] as const;

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDERS)[number];

export function isWebSearchProviderName(value: string): value is WebSearchProviderName {
  return (WEB_SEARCH_PROVIDERS as readonly string[]).includes(value);
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
  readonly linkup?: WebSearchProviderConfig;
  readonly provider?: WebSearchProviderName;
}

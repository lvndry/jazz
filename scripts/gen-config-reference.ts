/**
 * Regenerates the key table in `docs/configure/config-reference.md` from `ConfigFileSchema`,
 * the schema every config file is validated against.
 *
 * A hand-written list of settings drifts the first time someone adds a key, and a strict schema
 * turns that drift into a support problem: a key the docs never mention is a key nobody sets, and
 * a key the docs still mention after a rename is rejected on every command. So the table is
 * generated: one row per setting, with the value it accepts in the words `jazz config validate`
 * uses, whether it is a secret, and the one-line meaning from `SETTING_DESCRIPTIONS` below.
 *
 * `renderConfigReference()` returns the table; `configReferenceRows()` returns the rows. The
 * test beside this file fails when the page, the schema, or the descriptions disagree. Run
 * `bun run docs:config-reference` after changing the schema.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AVAILABLE_PROVIDERS } from "@jazz/core/constants/models";
import { isSecretPath } from "@jazz/core/secrets/registry";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/types/config";
import { ConfigFileSchema, describeExpected } from "@jazz/core/utils/config-schema";
import * as prettier from "prettier";
import { z } from "zod";

export const CONFIG_REFERENCE_DOC = path.join(
  import.meta.dir,
  "..",
  "docs",
  "configure",
  "config-reference.md",
);
export const TABLE_START = "<!-- config-reference:start -->";
export const TABLE_END = "<!-- config-reference:end -->";

/**
 * Object keys that stand for one member of a family, so every member shares a row. Keyed by the
 * normalized path of the object that holds them.
 */
const FAMILY_PLACEHOLDERS: Readonly<Record<string, { members: readonly string[]; name: string }>> =
  {
    llm: { members: AVAILABLE_PROVIDERS, name: "<provider>" },
    "llm.capabilityOverrides": { members: AVAILABLE_PROVIDERS, name: "<provider>" },
    web_search: { members: WEB_SEARCH_PROVIDERS, name: "<provider>" },
  };

/** The placeholder a record's free-form key gets, by the normalized path of the record. */
const RECORD_PLACEHOLDERS: Readonly<Record<string, string>> = {
  mcpServers: "<server>",
  "llm.capabilityOverrides.<provider>": "<model>",
  "telemetry.otlp.headers": "<header>",
  "telemetry.otlp.resourceAttributes": "<attribute>",
  "daemon.agents": "<agent>",
};

/**
 * What each setting does, keyed by its row path. Every row needs one, and every entry needs a
 * row: the test fails either way, so a new schema key cannot ship undocumented.
 */
export const SETTING_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "logging.retentionDays":
    "Days log files are kept after their last write. Defaults to 14; one-shot firing logs are kept for one day.",
  "logging.maxTotalSizeMB":
    "Size cap for the logs directory in megabytes. Oldest files are removed first. Defaults to 200.",
  "notify.targets[].name":
    "This target's name: the key its secrets are stored under (`notify.targets.<name>.<field>`) and what a workflow's `deliver` field names. See [Notifications](./notifications.md).",
  "notify.targets[].kind": "Delivery transport: desktop, ntfy, webhook, telegram or discord.",
  "notify.targets[].events":
    "Event subscriptions. Unset receives every subscribable event; workflow results go to the targets named by the workflow’s `deliver` field.",
  "notify.targets[].url":
    "ntfy topic URL, or the endpoint that receives each notification as a JSON POST (signed when the target has a secret).",
  "notify.targets[].chatId": "Telegram chat id to receive notifications.",
  "notify.targets[].channelId": "Discord channel id for delivery using a bot token.",
  "notify.targets[].apiBaseUrl": "Override the Telegram or Discord API base URL for bot delivery.",
  "notify.targets[].approveFromChat":
    "Include chat approval commands in parked-run notifications. Requires a running bridge with operators and `JAZZ_APPROVALS_HOME` configured. Defaults to false.",
  "history.maxConversationsPerAgent":
    "Conversations kept in each agent’s live history. Older conversations are archived, not deleted; active goal, loop and run conversations are protected. Defaults to 100.",
  "network.allowPrivateHosts":
    "Hosts on this machine or your local network agents may reach without asking: hostnames, `*.suffix` wildcards, IP addresses or CIDR blocks, at most 64. Any other private address asks for approval, and approving adds it here. Read from the global config only. See [Private network hosts](./jazz.md#private-network-hosts).",
  "network.httpApproval":
    "HTTP requests and web fetches run automatically by default, including private destinations and after untrusted content. Set a URL array to approve only matching requests automatically; every other request asks or parks. Exact HTTP(S) URLs include query strings; trailing /* grants a path prefix on the same origin. A one-call approval never changes the list. The browser tools load only matching URLs. Global config only.",
  "network.browserEndpoint":
    "A running browser the browser tools drive: an `http(s)://` or `ws(s)://` DevTools URL. Without it, the tools try a browser you run on the local DevTools port (`http://127.0.0.1:9222`), then a launched Chrome. Page content and typed text reach the browser's host. Global config only. See [Browser Use](../concepts/browser-use.md).",
  "storage.type": "Storage backend. `file` is the only one Jazz implements.",
  "storage.path": "Data directory for `file` storage. Defaults to the Jazz home (`~/.jazz`).",
  "storage.connectionString":
    "Connection string for `database` storage, which Jazz does not implement.",
  "logging.level":
    "Lowest level written to the log files. Defaults to `info`; `--debug` sets `debug`.",
  "logging.format": "Log line format. Defaults to `plain`; `json` writes one object per line.",
  "llm.streamIdleTimeoutMs":
    "How long a model stream may stay silent before Jazz abandons it, in milliseconds. Defaults to 120000.",
  "llm.capabilityOverrides.<provider>.<model>.supportsTools":
    "Whether the model can call tools, overriding the model catalog.",
  "llm.capabilityOverrides.<provider>.<model>.reasoning.kind":
    "Which reasoning control the model accepts. See [Model providers](./providers.md#model-capability-overrides).",
  "llm.capabilityOverrides.<provider>.<model>.reasoning.transport":
    "The request field that carries the reasoning control. Each `kind` accepts its own transports.",
  "llm.capabilityOverrides.<provider>.<model>.reasoning.canDisableReasoning":
    "Whether the model accepts reasoning turned off.",
  "llm.capabilityOverrides.<provider>.<model>.reasoning.efforts":
    "Effort levels the model accepts, for `effort`, `adaptive` and `manual`.",
  "llm.capabilityOverrides.<provider>.<model>.reasoning.minimumBudgetTokens":
    "Smallest thinking budget the model accepts, for `manual` and `budget`.",
  "llm.capabilityOverrides.<provider>.<model>.reasoning.maximumBudgetTokens":
    "Largest thinking budget the model accepts, for `manual` and `budget`.",
  "llm.<provider>.api_key":
    "API key for the provider, kept in the keyring when one is available. The provider's environment variable also works. See [Model providers](./providers.md).",
  "llm.<provider>.base_url": "Server address of a self-hosted provider.",
  "llm.anthropic.workspace_id":
    "Anthropic workspace, needed alongside a key tied to a Console user rather than a workspace.",
  "llm.chatgpt.account_id": "Account of the ChatGPT sign-in. Written by Jazz when you sign in.",
  "llm.chatgpt.plan": "Plan of the ChatGPT sign-in, such as `plus` or `pro`. Written by Jazz.",
  "llm.ollama.keep_alive":
    "How long Ollama keeps the model loaded, such as `30m`, or `-1` to keep it resident.",
  "web_search.<provider>.api_key": "API key for the web search provider.",
  "web_search.provider": "Web search provider agents use when an agent does not name one.",
  "output.showReasoning": "Show the model's reasoning. Defaults to true.",
  "output.showToolExecution": "Show each tool call as it runs. Defaults to true.",
  "output.collapseReasoning":
    "Collapse finished reasoning to one line; Ctrl+R expands it. Defaults to true.",
  "output.mode":
    "Terminal output style. Defaults to `hybrid`; `quiet` suppresses output for background runs.",
  "output.colorProfile":
    "Color depth: `full`, `basic` (16 colors, no emoji) or `none`. Detected from the terminal when unset.",
  "output.showMetrics":
    "Show first-token latency, tokens per second and duration after each answer. Defaults to true.",
  "output.streaming.enabled":
    "Stream answers as they arrive. Defaults to `auto`, which streams on a terminal.",
  "output.streaming.textBufferMs":
    "How long streamed text is batched before it is drawn, in milliseconds. Defaults to 50.",
  "mcpServers.<server>.enabled": "Turn a server defined in `.agents/mcp.json` on or off.",
  "mcpServers.<server>.trusted":
    "Let the server's tool annotations set their risk level. See [MCP](./mcp.md).",
  "notifications.enabled": "Send desktop notifications for completions and approvals.",
  "notifications.sound": "Play a sound with desktop notifications.",
  "notifications.terminal":
    "How desktop notifications reach a terminal that shows them itself: `auto` detects kitty, Ghostty, WezTerm, Warp and iTerm2; `osc99`, `osc777` or `osc9` forces that escape sequence (for example over SSH); `off` always uses the system notifier. `JAZZ_NOTIFICATIONS_TERMINAL` wins. Defaults to `auto`. See [Desktop notifications](./notifications.md#desktop-notifications).",
  autoApprovedCommands:
    "Shell commands approved without asking. See [Approvals](../security/approvals.md).",
  "telemetry.enabled": "Record local telemetry. Defaults to true.",
  "telemetry.storagePath":
    "Directory for local telemetry. Defaults to `telemetry` in the Jazz home.",
  "telemetry.bufferSize": "Events held in memory before a flush. Defaults to 100.",
  "telemetry.flushIntervalMs":
    "Time between automatic flushes, in milliseconds. Defaults to 30000.",
  "telemetry.retentionDays": "Days local telemetry is kept. Defaults to 90.",
  "telemetry.otlp.enabled":
    "Set to false to stop OTLP export while keeping the endpoint configured. Export is on whenever an endpoint is set.",
  "telemetry.otlp.signals": "Signals to export. Defaults to `traces`; add `logs` or `metrics`.",
  "telemetry.otlp.endpoint":
    "Collector base URL, such as `http://localhost:4318`. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`.",
  "telemetry.otlp.tracesEndpoint": "Full traces URL, overriding `endpoint`.",
  "telemetry.otlp.logsEndpoint": "Full logs URL, overriding `endpoint`.",
  "telemetry.otlp.metricsEndpoint": "Full metrics URL, overriding `endpoint`.",
  "telemetry.otlp.headers.<header>":
    "An HTTP header sent with every export, typically auth. Every header is stored as a secret.",
  "telemetry.otlp.serviceName": "`service.name` on exported records. Defaults to `jazz`.",
  "telemetry.otlp.resourceAttributes.<attribute>":
    "A resource attribute on every exported record, such as `deployment.environment`.",
  "telemetry.otlp.timeoutMs": "Per-request export timeout, in milliseconds. Defaults to 10000.",
  "telemetry.otlp.maxQueuedBytes": "Disk space for pending traces and logs. Defaults to 32 MiB.",
  "telemetry.otlp.maxQueueAgeMs":
    "Age at which pending traces and logs are dropped, in milliseconds. Defaults to seven days.",
  "telemetry.otlp.metricExportIntervalMs":
    "Time between metric exports, in milliseconds. Defaults to 30000.",
  maxRetries: "Retries for a transient model API failure. Defaults to 10.",
  editor:
    "Editor for `jazz persona edit` and `jazz mcp add`, such as `code --wait`. Defaults to `$VISUAL`, then `$EDITOR`, then `vi`.",
  maxSubagentDepth:
    "How many levels of sub-agents may nest. Defaults to 3; 0 turns delegation off.",
  maxIterations: "Model rounds per top-level run. Defaults to 100; `--max-iterations` wins.",
  maxSubagentIterations: "Model rounds per sub-agent run. Defaults to 30.",
  maxCostUSD:
    "Spend ceiling per run, in US dollars. Unset means no ceiling; `--max-cost-usd` wins. See [Budgets](../concepts/budgets.md).",
  maxTokens: "Token ceiling per run. Unset means no ceiling; `--max-tokens` wins.",
  maxDurationMs:
    "Wall-clock ceiling per run, in milliseconds. Unset means no ceiling; `--max-duration-ms` wins.",
  "context.warnThresholdRatio":
    "Share of the context window at which the model is told it is filling up. Defaults to 0.7.",
  "context.compactThresholdRatio":
    "Share of the context window at which history is compacted. Defaults to 0.8.",
  workspaceMaxTotalBytesPerAgent:
    "Size cap for one agent's workspace directory, in bytes. Defaults to 1 GB.",
  "scheduler.mode":
    "`auto` schedules workflows with launchd on macOS and cron on Linux; `in-process` leaves it to `jazz daemon`. See [Scheduling](./jazz.md#scheduling).",
  "peers[].name":
    "Local name for the peer, used in commands and the ledger. See [Agent-to-agent](../concepts/agent-to-agent.md).",
  "peers[].url": "The peer's endpoint, needed to ask them.",
  "peers[].disclosure": "The tier you grant this peer when it asks you. Unset grants nothing.",
  "peers[].persona": "Persona your agent answers this peer with.",
  "peers[].allow": "Tools this peer may reach by name, beyond its disclosure tier.",
  "peers[].budget.maxTokens": "Token ceiling for each run this peer starts.",
  "peers[].budget.maxCostUSD": "Spend ceiling in US dollars for each run this peer starts.",
  "peers[].budget.maxDurationMs":
    "Wall-clock ceiling in milliseconds for each run this peer starts.",
  "peers[].maxConcurrentRuns":
    "Runs this peer may have in flight at once; a request past it is refused with `429`. Defaults to 4.",
  "hosts[].name":
    "Name of a machine registered for detached conversations. See [Detached conversations](../concepts/detach.md).",
  "hosts[].sshTarget": "SSH config alias for the machine.",
  "hosts[].workspacePath": "Absolute directory on the machine dedicated to Jazz transfers.",
  "hosts[].allowFileSecrets":
    "Let a machine without a keyring keep handed-off provider keys in its secrets file. Off by default.",
  "webhooks[].name": "Name in the webhook URL. See [Webhooks](../concepts/webhooks.md).",
  "webhooks[].agentId": "Agent the webhook runs.",
  "webhooks[].promptTemplate":
    "Prompt run when the webhook fires. `{{payload}}` becomes the request body, quoted as data.",
  "webhooks[].description": "What the webhook is for.",
  "webhooks[].conversation":
    "`ephemeral` starts fresh on each call; `threaded` continues one conversation.",
  "webhooks[].disclosure": "What the webhook's answers may reveal. Defaults to `internal`.",
  "webhooks[].allow": "Tools the webhook run may reach by name, beyond its disclosure tier.",
  "webhooks[].signature.format":
    "Authenticate each request by an `hmac-sha256` signature over its body instead of a bearer token. Set the shared secret with `jazz webhook secret <name>`.",
  "webhooks[].signature.header":
    "Request header holding the signature. Defaults to `x-hub-signature-256`.",
  "webhooks[].signature.prefix":
    "Text before the hex digest in that header. Defaults to `sha256=`.",
  "webhooks[].deliveryIdHeader":
    "Header carrying each delivery's id; a delivery already received is refused. Defaults to `x-github-delivery`.",
  "webhooks[].budget.maxTokens": "Token ceiling for each run this webhook starts.",
  "webhooks[].budget.maxCostUSD": "Spend ceiling in US dollars for each run this webhook starts.",
  "webhooks[].budget.maxDurationMs":
    "Wall-clock ceiling in milliseconds for each run this webhook starts.",
  "webhooks[].maxConcurrentRuns":
    "Runs this webhook may have in flight at once; a request past it is refused with `429`. Defaults to 4.",
  "daemon.dailyCostUSD":
    "Most dollars unattended runs may spend per day, across all of them. Reaching it, or an unpriced unattended run today, pauses the daemon's own work until midnight or `jazz daemon resume`. Unset is unlimited. See [Spend caps](./jazz.md#spend-caps-and-notifications).",
  "daemon.monthlyCostUSD":
    "Most dollars unattended runs may spend per local month, across all of them. Unset is unlimited.",
  "daemon.dailyTokens":
    "Most prompt and completion tokens unattended runs may spend per day, across all of them.",
  "daemon.goals.dailyCostUSD":
    "Combined goal-cycle and loop-run spend cap per local day, in dollars. Unset is unlimited.",
  "daemon.goals.monthlyCostUSD":
    "Combined goal-cycle and loop-run spend cap per local month, in dollars. Unset is unlimited.",
  "daemon.agents.<agent>.dailyCostUSD":
    "Unattended spend cap per local day, in dollars, for the agent this key names (agent name or id). Unset is unlimited.",
  "daemon.agents.<agent>.monthlyCostUSD":
    "Unattended spend cap per local month, in dollars, for the agent this key names (agent name or id). Unset is unlimited.",
  "daemon.token":
    "The daemon's bearer token, written here only on a host without a keyring. Written by Jazz.",
  "ui.theme":
    "The theme, such as `jazz`, `catppuccin:light` or a file in `~/.jazz/themes`. `/theme` writes it; `JAZZ_THEME` wins. Defaults to `system` (your terminal's own colours).",
  "ui.canvas":
    "`inherit` leaves your terminal's background showing; `painted` fills every cell with the theme's background. Defaults to `inherit`.",
  "chat.defaultCostLimitUSD":
    "Starting value of a new chat session's `/limit usd` cap, in dollars. `/limit` can still raise, lower or clear it for that session. Unset is unlimited.",
};

export interface ConfigReferenceRow {
  /** Dotted path with placeholders: `llm.<provider>.api_key`, `peers[].name`. */
  readonly path: string;
  /** What the value must be, in the words `jazz config validate` uses. */
  readonly accepts: string;
  readonly secret: boolean;
  /** The family members the row applies to, when the path has a family placeholder. */
  readonly members: readonly string[];
}

interface Leaf {
  readonly path: string;
  readonly concretePath: string;
  readonly schema: z.ZodType;
  readonly members: readonly string[];
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodExactOptional || current instanceof z.ZodOptional) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

function objectOptions(schema: z.ZodType): readonly z.ZodObject[] | undefined {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) {
    return [inner];
  }
  if (inner instanceof z.ZodDiscriminatedUnion) {
    return (inner.options as readonly z.ZodType[]).map((option) => unwrap(option) as z.ZodObject);
  }
  return undefined;
}

function join(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function collectLeaves(
  schema: z.ZodType,
  normalized: string,
  concrete: string,
  members: readonly string[],
  leaves: Leaf[],
): void {
  const options = objectOptions(schema);
  if (options !== undefined) {
    const family = FAMILY_PLACEHOLDERS[normalized];
    for (const option of options) {
      const shape: Readonly<Record<string, z.ZodType>> = option.shape;
      for (const [key, child] of Object.entries(shape)) {
        const isMember = family?.members.includes(key) ?? false;
        collectLeaves(
          child,
          join(normalized, isMember && family ? family.name : key),
          join(concrete, key),
          isMember ? [key] : members,
          leaves,
        );
      }
    }
    return;
  }
  const inner = unwrap(schema);
  if (inner instanceof z.ZodRecord) {
    const placeholder = RECORD_PLACEHOLDERS[normalized] ?? "<name>";
    collectLeaves(
      inner.valueType as z.ZodType,
      join(normalized, placeholder),
      join(concrete, "example"),
      members,
      leaves,
    );
    return;
  }
  if (inner instanceof z.ZodArray && objectOptions(inner.element as z.ZodType) !== undefined) {
    collectLeaves(inner.element as z.ZodType, `${normalized}[]`, `${concrete}[0]`, members, leaves);
    return;
  }
  leaves.push({ path: normalized, concretePath: concrete, schema: inner, members });
}

/**
 * What a value at a path shared by several schemas must be. Schemas that read the same are
 * described once; distinct ones are described as one union, so the alternatives read as a
 * single list.
 */
function describeAccepted(schemas: readonly z.ZodType[]): string {
  const distinct = new Map<string, z.ZodType>();
  for (const schema of schemas) {
    distinct.set(describeExpected(schema), schema);
  }
  const [only, ...rest] = [...distinct.values()];
  if (only === undefined) {
    return "";
  }
  return rest.length === 0 ? describeExpected(only) : describeExpected(z.union([only, ...rest]));
}

/** A family placeholder replaced by the one member a row covers: `llm.anthropic.workspace_id`. */
function withSoleMember(rowPath: string, members: readonly string[]): string {
  const [sole] = members;
  if (members.length !== 1 || sole === undefined) {
    return rowPath;
  }
  for (const [parent, family] of Object.entries(FAMILY_PLACEHOLDERS)) {
    const prefix = `${parent}.${family.name}`;
    if (rowPath.startsWith(prefix)) {
      return `${parent}.${sole}${rowPath.slice(prefix.length)}`;
    }
  }
  return rowPath;
}

/** One row per setting a config file may hold, in schema order. */
export function configReferenceRows(): readonly ConfigReferenceRow[] {
  const leaves: Leaf[] = [];
  collectLeaves(ConfigFileSchema, "", "", [], leaves);
  const rows = new Map<string, { schemas: z.ZodType[]; secret: boolean; members: Set<string> }>();
  for (const leaf of leaves) {
    const row = rows.get(leaf.path) ?? { schemas: [], secret: false, members: new Set<string>() };
    row.schemas.push(leaf.schema);
    row.secret ||= isSecretPath(leaf.concretePath);
    for (const member of leaf.members) {
      row.members.add(member);
    }
    rows.set(leaf.path, row);
  }
  return [...rows].map(([rowPath, row]) => ({
    path: withSoleMember(rowPath, [...row.members]),
    accepts: describeAccepted(row.schemas),
    secret: row.secret,
    members: [...row.members],
  }));
}

function familyOf(rowPath: string): readonly string[] | undefined {
  if (!rowPath.includes("<provider>")) {
    return undefined;
  }
  for (const [parent, family] of Object.entries(FAMILY_PLACEHOLDERS)) {
    if (rowPath.startsWith(`${parent}.${family.name}`)) {
      return family.members;
    }
  }
  return undefined;
}

/** Which family members a row covers when it is not all of them: all but a few, or a list. */
function describeMembers(row: ConfigReferenceRow): string {
  const family = familyOf(row.path);
  if (family === undefined || row.members.length === 0) {
    return "";
  }
  const code = (names: readonly string[]) => names.map((name) => `\`${name}\``).join(", ");
  if (row.members.length === family.length) {
    return "";
  }
  const missing = family.filter((member) => !row.members.includes(member));
  if (missing.length <= 3) {
    return ` Applies to every provider except ${code(missing)}.`;
  }
  return ` Applies to ${code(row.members)}.`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

/** The generated table, without the markers around it. */
export function renderConfigReference(): string {
  const lines = ["| Key | Accepts | Secret | What it does |", "| --- | --- | --- | --- |"];
  for (const row of configReferenceRows()) {
    const description = SETTING_DESCRIPTIONS[row.path] ?? "";
    lines.push(
      `| \`${row.path}\` | ${escapeCell(row.accepts)} | ${row.secret ? "yes" : ""} | ${escapeCell(description + describeMembers(row))} |`,
    );
  }
  return lines.join("\n");
}

/**
 * The page with its table region replaced by the generated table, formatted the way the
 * repository's Prettier config formats Markdown, so the pre-commit hook leaves it unchanged.
 */
export async function regeneratedPage(page: string): Promise<string> {
  const start = page.indexOf(TABLE_START);
  const end = page.indexOf(TABLE_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `${path.basename(CONFIG_REFERENCE_DOC)} is missing its ${TABLE_START} / ${TABLE_END} markers`,
    );
  }
  const replaced = `${page.slice(0, start + TABLE_START.length)}\n\n${renderConfigReference()}\n\n${page.slice(end)}`;
  const options = (await prettier.resolveConfig(CONFIG_REFERENCE_DOC)) ?? {};
  return prettier.format(replaced, { ...options, filepath: CONFIG_REFERENCE_DOC });
}

// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Bun script entry point.
if (import.meta.main) {
  const page = readFileSync(CONFIG_REFERENCE_DOC, "utf-8");
  writeFileSync(CONFIG_REFERENCE_DOC, await regeneratedPage(page));
  console.log(
    `✓ regenerated the settings table in ${path.relative(process.cwd(), CONFIG_REFERENCE_DOC)}`,
  );
}

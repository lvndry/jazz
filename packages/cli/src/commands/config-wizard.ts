/**
 * Interactive `jazz config` wizard: menu-driven editing of LLM providers, web
 * search providers, output display, logging, scheduler mode, notifications, and
 * spend limits.
 */

import { loadChatGPTCredential } from "@jazz/adapters/llm/chatgpt";
import { normalizeLocalProviderBaseUrl } from "@jazz/adapters/llm/models";
import { WEB_SEARCH_PROVIDERS } from "@jazz/core/agent/tools/web-search";
import {
  isLocalServerProvider,
  LOCAL_SERVER_PROVIDERS,
  localServerAddress,
} from "@jazz/core/constants/local-providers";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@jazz/core/constants/models";
import { AgentConfigServiceTag } from "@jazz/core/interfaces/agent-config";
import type { ChoicePreviewLine, TerminalService } from "@jazz/core/interfaces/terminal";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { resolveDisplayConfig } from "@jazz/core/presentation/display-config";
import type {
  AppConfig,
  DaemonConfig,
  LoggingConfig,
  SchedulerMode,
  TerminalNotificationSetting,
  WebSearchProviderName,
} from "@jazz/core/types/config";
import type { ColorProfile, OutputMode } from "@jazz/core/types/output";
import { isRecord } from "@jazz/core/utils/is-record";
import {
  configuredProviderApiKey,
  formatProviderDisplayName,
  isChatGPTSignedIn,
} from "@jazz/core/utils/provider-model";
import { sortProvidersForPicker } from "@jazz/core/utils/provider-picker";
import { Effect } from "effect";
import { addPrivateHost, applyPrivateHosts, removePrivateHost } from "./private-hosts";
import {
  applySpendLimit,
  describeSpendLimit,
  parseSpendLimitInput,
  SPEND_LIMIT_SETTINGS,
} from "./spend-limits";
import { commitTheme } from "../chat/commands/handler";
import { signInToChatGPT, signOutOfChatGPT } from "../helpers/chatgpt-sign-in";
import { isValidServerAddress } from "../helpers/local-provider-url";
import { writeClipboard } from "../ui/fullscreen/clipboard";
import { activeKeymapMode } from "../ui/keymaps";
import { configuredProviderNames } from "../ui/models/configured-providers";
import { store, type ActiveMenuOption } from "../ui/store";
import { THEME } from "../ui/theme";
import { pickThemeInteractively } from "../ui/theme-picker-prompt";

/**
 * Menu actions for the config wizard
 */
type ConfigMenuAction =
  | "llm-providers"
  | "web-search"
  | "output-display"
  | "scheduler"
  | "logging"
  | "notifications"
  | "spend-limits"
  | "private-hosts"
  | "back";

/**
 * Main entry point for the configuration wizard
 */
export function configWizardCommand() {
  return Effect.gen(function* () {
    let stayInMenu = true;

    while (stayInMenu) {
      const config = yield* (yield* AgentConfigServiceTag).appConfig;
      const menuOptions = settingsMenuOptions(config);

      const selection = yield* showConfigMenu(menuOptions);

      switch (selection) {
        case "llm-providers": {
          yield* configureLLMProviders();
          break;
        }
        case "web-search": {
          yield* configureWebSearchProviders();
          break;
        }
        case "output-display": {
          yield* configureOutputDisplay();
          break;
        }
        case "scheduler": {
          yield* configureScheduler();
          break;
        }
        case "logging": {
          yield* configureLogging();
          break;
        }
        case "notifications": {
          yield* configureNotifications();
          break;
        }
        case "spend-limits": {
          yield* configureSpendLimits();
          break;
        }
        case "private-hosts": {
          yield* configurePrivateHosts();
          break;
        }
        case "back": {
          stayInMenu = false;
          break;
        }
      }
    }
  });
}

function spendHint(caps: DaemonConfig | undefined): string {
  const parts = [
    ...(caps?.goals?.dailyCostUSD === undefined
      ? []
      : [`$${String(caps.goals.dailyCostUSD)} / day`]),
    ...(caps?.goals?.monthlyCostUSD === undefined
      ? []
      : [`$${String(caps.goals.monthlyCostUSD)} / month`]),
  ];
  return parts.length === 0 ? "no limit" : parts.join(" · ");
}

/** The settings list, each row with the value it has now. */
export function settingsMenuOptions(config: AppConfig): ActiveMenuOption[] {
  const providers = configuredProviderNames(config).length;
  const searchProviders = Object.entries(config.web_search ?? {}).filter(
    ([, value]) =>
      isRecord(value) && typeof value["api_key"] === "string" && value["api_key"] !== "",
  ).length;
  const notifications = config.notifications?.enabled;
  return [
    {
      label: "Model providers",
      value: "llm-providers",
      hint: providers === 0 ? "none has a key yet" : `${String(providers)} ready`,
    },
    {
      label: "Web search",
      value: "web-search",
      hint: searchProviders === 0 ? "no key saved" : `${String(searchProviders)} with a key`,
    },
    {
      label: "Output and display",
      value: "output-display",
      hint: config.ui?.theme ?? "theme follows the terminal",
    },
    { label: "Scheduler", value: "scheduler" },
    { label: "Logging", value: "logging", hint: config.logging.level },
    {
      label: "Notifications",
      value: "notifications",
      hint: notifications === undefined ? "not set up" : notifications ? "on" : "off",
    },
    { label: "Spend limits", value: "spend-limits", hint: spendHint(config.daemon) },
    {
      label: "Private network hosts",
      value: "private-hosts",
      hint:
        (config.network?.allowPrivateHosts?.length ?? 0) === 0
          ? "none allowed"
          : `${String(config.network?.allowPrivateHosts?.length)} allowed`,
    },
    { label: "Back", value: "back" },
  ];
}

function showConfigMenu(
  options: readonly ActiveMenuOption[],
): Effect.Effect<ConfigMenuAction, never, never> {
  return Effect.async<ConfigMenuAction>((resume) => {
    store.setActiveMenu(
      {
        kind: "menu",
        title: "Settings",
        options,
      },
      (result) => {
        resume(
          Effect.succeed(result.kind === "exit" ? "back" : (result.value as ConfigMenuAction)),
        );
      },
    );
  });
}

/** Copy a saved credential on explicit `c`; return true only when the user chose to edit it. */
function copyOrEditCredential(
  terminal: TerminalService,
  label: string,
  credential: string,
): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const action = yield* terminal.ask(`${label}: ••••••••  [e]dit · [c]opy`, {
      hidden: true,
      keys: ["e", "c"],
    });
    if (action === "e") return true;
    if (action === "c") yield* copyCredential(terminal, credential, label);
    return false;
  });
}

/** Write a credential to the system clipboard without putting it in terminal output. */
function copyCredential(
  terminal: TerminalService,
  credential: string,
  label: string,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => writeClipboard(credential),
    catch: (error) => error as Error,
  }).pipe(
    Effect.flatMap((copied) =>
      copied
        ? terminal.success(`${label} copied to clipboard.`)
        : terminal.error(
            "Could not access a clipboard. Install a clipboard utility and try again.",
          ),
    ),
    Effect.catchAll((error) => terminal.error(`Could not copy credential: ${error.message}`)),
  );
}

function configureLLMProviders() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      // Get current config to show status
      const config = yield* configService.appConfig;

      const choices: { name: string; value: ProviderName | "back" }[] = sortProvidersForPicker(
        AVAILABLE_PROVIDERS,
      ).map((provider) => {
        const configured = isLocalServerProvider(provider)
          ? !!config.llm?.[provider]?.base_url || !!config.llm?.[provider]?.api_key
          : provider === "chatgpt"
            ? isChatGPTSignedIn(config.llm)
            : !!configuredProviderApiKey(config.llm, provider);
        return {
          name: `${formatProviderDisplayName(provider)} ${configured ? "(configured)" : ""}`,
          value: provider,
        };
      });

      choices.push({ name: "Back", value: "back" });

      const providerChoice = yield* terminal.select<string>("Select provider to configure:", {
        choices,
      });

      if (!providerChoice || providerChoice === "back") {
        break;
      }

      const provider = providerChoice as ProviderName;

      const providerDisplay = formatProviderDisplayName(provider);
      yield* terminal.info(`Configuring ${providerDisplay}...`);

      if (isLocalServerProvider(provider)) {
        const currentBaseUrl = config.llm?.[provider]?.base_url;
        const currentAddress = currentBaseUrl ? localServerAddress(currentBaseUrl) : undefined;
        const defaultUrl = LOCAL_SERVER_PROVIDERS[provider].defaultUrl;
        const address = yield* terminal.ask(
          `${providerDisplay} server address (host:port, or full URL) (leave empty to ${currentAddress ? `keep ${currentAddress}` : `use default ${defaultUrl}`}):`,
          {
            simple: true,
            placeholder: currentAddress ?? defaultUrl,
            validate: isValidServerAddress,
          },
        );

        if (address?.trim()) {
          const normalized = normalizeLocalProviderBaseUrl(provider, address);
          yield* configService.set(`llm.${provider}.base_url`, normalized);
          yield* terminal.success(
            `${providerDisplay} server set to ${localServerAddress(normalized)}.`,
          );
        } else {
          yield* terminal.info("No changes made.");
        }

        // Ollama uses a key for :cloud models; the OpenAI-compatible local servers can require keys.
        if (provider === "llamacpp" || provider === "vllm" || provider === "sglang") {
          const existingKey = configuredProviderApiKey(config.llm, provider);
          if (
            existingKey &&
            !(yield* copyOrEditCredential(terminal, providerDisplay, existingKey))
          ) {
            continue;
          }
          const serverKey = yield* terminal.ask(
            `${providerDisplay} server API key (only if it runs with --api-key; leave empty to keep current):`,
            { simple: true, secret: true, cancellable: true },
          );
          if (serverKey === undefined) continue;
          if (serverKey?.trim()) {
            yield* configService.set(`llm.${provider}.api_key`, serverKey);
            yield* terminal.success(`${providerDisplay} API key updated.`);
          }
        }
        if (provider === "ollama") {
          const existingKey = configuredProviderApiKey(config.llm, provider);
          if (
            existingKey &&
            !(yield* copyOrEditCredential(terminal, "Ollama Cloud", existingKey))
          ) {
            continue;
          }
          const cloudKey = yield* terminal.ask(
            "Ollama Cloud API key (only for :cloud models; leave empty to keep current):",
            { simple: true, secret: true, cancellable: true },
          );
          if (cloudKey === undefined) continue;
          if (cloudKey?.trim()) {
            yield* configService.set(`llm.${provider}.api_key`, cloudKey);
            yield* terminal.success("Ollama Cloud API key updated.");
          }
        }

        yield* terminal.log(""); // Spacing
        continue;
      }

      if (provider === "chatgpt") {
        if (isChatGPTSignedIn(config.llm)) {
          const credentialAction = yield* terminal.ask(
            "OAuth credential: ••••••••  [e]dit account · [c]opy credential",
            { hidden: true, keys: ["e", "c"] },
          );
          if (credentialAction === "c") {
            const result = yield* Effect.either(
              Effect.tryPromise({
                try: loadChatGPTCredential,
                catch: (error) => error as Error,
              }),
            );
            if (result._tag === "Left") {
              yield* terminal.error(`Could not read ChatGPT credential: ${result.left.message}`);
            } else if (!result.right) {
              yield* terminal.error("ChatGPT credential is unavailable. Sign in again.");
            } else {
              yield* copyCredential(
                terminal,
                JSON.stringify(result.right),
                "ChatGPT OAuth credential",
              );
            }
            continue;
          }
          if (credentialAction !== "e") continue;
          const accountAction = yield* terminal.select<"keep" | "switch" | "sign-out">(
            "You are signed in to ChatGPT.",
            {
              choices: [
                { name: "Keep this account", value: "keep" },
                { name: "Sign in with a different account", value: "switch" },
                { name: "Sign out", value: "sign-out" },
              ],
            },
          );
          if (accountAction === "sign-out") {
            yield* signOutOfChatGPT(terminal, configService);
          } else if (accountAction === "switch") {
            yield* signInToChatGPT(terminal, configService);
          }
        } else {
          yield* signInToChatGPT(terminal, configService);
        }
        yield* terminal.log("");
        continue;
      }

      const existingKey = configuredProviderApiKey(config.llm, provider);
      if (existingKey && !(yield* copyOrEditCredential(terminal, providerDisplay, existingKey))) {
        continue;
      }

      const apiKey = yield* terminal.ask(
        `Enter API Key for ${providerDisplay} (leave empty to keep current):`,
        { simple: true, secret: true, cancellable: true },
      );
      if (apiKey === undefined) continue;

      if (apiKey?.trim()) {
        yield* configService.set(`llm.${provider}.api_key`, apiKey);
        yield* terminal.success(`Configuration for ${providerDisplay} updated.`);
      } else {
        yield* terminal.info("No changes made.");
      }

      if (provider === "anthropic") {
        const currentWorkspaceId = config.llm?.anthropic?.workspace_id;
        const workspaceId = yield* terminal.ask(
          `Anthropic workspace ID (only needed with an identity-linked API key; leave empty to ${currentWorkspaceId ? "keep current" : "skip"}):`,
          { simple: true, ...(currentWorkspaceId ? { defaultValue: currentWorkspaceId } : {}) },
        );
        if (workspaceId?.trim()) {
          yield* configService.set("llm.anthropic.workspace_id", workspaceId.trim());
          yield* terminal.success("Anthropic workspace ID updated.");
        }
      }

      yield* terminal.log(""); // Spacing
    }
  });
}

function configureWebSearchProviders() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const config = yield* configService.appConfig;
      const currentProvider = config.web_search?.provider;
      const providerDisplay = currentProvider ?? "Built-in (if available)";

      const choices = [
        {
          name: `Select external provider (current: ${providerDisplay})`,
          value: "select-provider",
        },
        ...WEB_SEARCH_PROVIDERS.map((p) => {
          const hasKey = !!config.web_search?.[p.value]?.api_key;
          return {
            name: `${p.name} API Key ${hasKey ? "(configured)" : ""}`,
            value: p.value,
          };
        }),
        { name: "Back", value: "back" },
      ];

      const selection = yield* terminal.select<string>("Web Search Configuration:", {
        choices,
      });

      if (!selection || selection === "back") {
        break;
      }

      if (selection === "select-provider") {
        const providerChoices: Array<{ name: string; value: WebSearchProviderName | "none" }> = [
          { name: "None (use built-in if available)", value: "none" },
          ...WEB_SEARCH_PROVIDERS.map((p) => ({
            name: p.name,
            value: p.value,
          })),
        ];

        const choice = yield* terminal.select<WebSearchProviderName | "none">("Select provider:", {
          choices: providerChoices,
        });

        if (choice === "none") {
          yield* configService.set("web_search.provider", undefined);
          yield* terminal.success(
            "External provider disabled. Built-in provider web search will be used if available.",
          );
        } else if (choice) {
          yield* configService.set("web_search.provider", choice);
          yield* terminal.success(`External provider set to ${choice}.`);
        }
      } else {
        const provider = selection as WebSearchProviderName;

        yield* terminal.info(`Configuring ${provider}...`);
        const existingKey = config.web_search?.[provider]?.api_key;
        if (
          existingKey &&
          !(yield* copyOrEditCredential(terminal, `${provider} API key`, existingKey))
        ) {
          continue;
        }
        const apiKey = yield* terminal.ask(
          `Enter API Key for ${provider} (leave empty to keep current):`,
          { simple: true, secret: true, cancellable: true },
        );
        if (apiKey === undefined) continue;

        if (apiKey?.trim()) {
          yield* configService.set(`web_search.${provider}.api_key`, apiKey);
          yield* terminal.success(`Configuration for ${provider} updated.`);
        } else {
          yield* terminal.info("No changes made.");
        }
      }

      yield* terminal.log(""); // Spacing
    }
  });
}

/** How a chat reply's `**bold** and \`code\`` reads under each output mode. */
const OUTPUT_MODE_PREVIEWS: Readonly<Record<OutputMode, readonly ChoicePreviewLine[]>> = {
  hybrid: [
    [
      { text: "**", fg: THEME.muted },
      { text: "bold", fg: THEME.selected, bold: true },
      { text: "**", fg: THEME.muted },
      { text: " and ", fg: THEME.secondary },
      { text: "`code`", fg: THEME.primary },
    ],
    [{ text: "Markdown stays visible, styled on top.", fg: THEME.muted }],
  ],
  raw: [
    [{ text: "**bold** and `code`", fg: THEME.secondary }],
    [{ text: "No styling at all — safe to copy or pipe.", fg: THEME.muted }],
  ],
  rendered: [
    [
      { text: "bold", fg: THEME.selected, bold: true },
      { text: " and ", fg: THEME.secondary },
      { text: "code", fg: THEME.primary },
    ],
    [{ text: "Markdown is fully interpreted, markers dropped.", fg: THEME.muted }],
  ],
  quiet: [
    [{ text: "(nothing prints)", fg: THEME.muted }],
    [{ text: "For cron jobs and scripts reading only the result.", fg: THEME.muted }],
  ],
};

/** Standard xterm 16-color hues — visibly cruder than the theme's own palette, on purpose. */
const ANSI_16_RED = "#CD0000";
const ANSI_16_GREEN = "#00CD00";
const ANSI_16_YELLOW = "#CDCD00";
const ANSI_16_BLUE = "#0000EE";
const ANSI_16_MAGENTA = "#CD00CD";

const FULL_COLOR_SWATCH: ChoicePreviewLine = [
  { text: "██ ", fg: THEME.primary },
  { text: "██ ", fg: THEME.success },
  { text: "██ ", fg: THEME.warning },
  { text: "██ ", fg: THEME.error },
  { text: "██", fg: THEME.selected },
];

/** How each color profile paints the same five-swatch sample. */
const COLOR_PROFILE_PREVIEWS: Readonly<
  Record<"auto" | ColorProfile, readonly ChoicePreviewLine[]>
> = {
  auto: [FULL_COLOR_SWATCH, [{ text: "Detected from your terminal.", fg: THEME.muted }]],
  full: [FULL_COLOR_SWATCH, [{ text: "Every hue exactly as designed.", fg: THEME.muted }]],
  basic: [
    [
      { text: "██ ", fg: ANSI_16_RED },
      { text: "██ ", fg: ANSI_16_GREEN },
      { text: "██ ", fg: ANSI_16_YELLOW },
      { text: "██ ", fg: ANSI_16_BLUE },
      { text: "██", fg: ANSI_16_MAGENTA },
    ],
    [{ text: "16 colors, rounded to the nearest one.", fg: THEME.muted }],
  ],
  none: [
    [
      { text: "██ ", fg: THEME.muted },
      { text: "██ ", fg: THEME.muted },
      { text: "██ ", fg: THEME.muted },
      { text: "██ ", fg: THEME.muted },
      { text: "██", fg: THEME.muted },
    ],
    [{ text: "No color; every line reads the same.", fg: THEME.muted }],
  ],
};

/** How the same log line reads under each format. */
const LOG_FORMAT_PREVIEWS: Readonly<Record<LoggingConfig["format"], readonly ChoicePreviewLine[]>> =
  {
    plain: [
      [
        { text: "12:03:41 ", fg: THEME.muted },
        { text: "INFO  ", fg: THEME.success },
        { text: "agent started", fg: THEME.secondary },
      ],
      [{ text: "One line per entry, read at a glance.", fg: THEME.muted }],
    ],
    json: [
      [{ text: '{"level":"info","msg":"agent started"}', fg: THEME.secondary }],
      [{ text: "One JSON object per line, for log processors.", fg: THEME.muted }],
    ],
  };

/** Marks a choice as the value already saved, so a picker never leaves you guessing which one. */
function currentTag(isCurrent: boolean): { tag?: string; tagTone?: "accent" } {
  return isCurrent ? { tag: "current", tagTone: "accent" } : {};
}

function configureOutputDisplay() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;
    const handleBooleanToggle = function* (options: {
      prompt: string;
      currentValue: boolean;
      configKey: `output.${string}`;
      label: string;
    }) {
      const nextValue = yield* terminal.confirm(options.prompt, options.currentValue);
      if (nextValue === undefined) {
        return;
      }
      yield* configService.set(options.configKey, nextValue);
      yield* terminal.success(`${options.label} ${nextValue ? "enabled" : "disabled"}.`);
    };

    while (true) {
      const appConfig = yield* configService.appConfig;
      const displayConfig = resolveDisplayConfig(appConfig);
      const showMetrics = appConfig.output?.showMetrics ?? true;
      const colorProfileLabel = appConfig.output?.colorProfile ?? "auto";

      const selection = yield* terminal.select<string>("Output & display settings:", {
        choices: [
          { name: `Output mode (${displayConfig.mode})`, value: "mode" },
          { name: `Color profile (${colorProfileLabel})`, value: "color-profile" },
          { name: `Theme (${appConfig.ui?.theme ?? "system"})`, value: "theme" },
          {
            name: `Show reasoning (${displayConfig.showReasoning ? "on" : "off"})`,
            value: "show-reasoning",
          },
          {
            name: `Reasoning (${displayConfig.collapseReasoning !== false ? "collapse" : "always show"})`,
            value: "collapse-reasoning",
          },
          {
            name: `Show tool execution (${displayConfig.showToolExecution ? "on" : "off"})`,
            value: "show-tool-execution",
          },
          { name: `Show metrics (${showMetrics ? "on" : "off"})`, value: "show-metrics" },
          { name: "Back", value: "back" },
        ],
      });

      if (!selection || selection === "back") {
        break;
      }

      switch (selection) {
        case "mode": {
          const mode = yield* terminal.select<OutputMode>("Select output mode:", {
            default: displayConfig.mode,
            choices: [
              {
                name: "Hybrid (styled, copy-paste friendly)",
                value: "hybrid",
                preview: OUTPUT_MODE_PREVIEWS.hybrid,
                ...currentTag(displayConfig.mode === "hybrid"),
              },
              {
                name: "Raw (plain text)",
                value: "raw",
                preview: OUTPUT_MODE_PREVIEWS.raw,
                ...currentTag(displayConfig.mode === "raw"),
              },
              {
                name: "Rendered (styled)",
                value: "rendered",
                preview: OUTPUT_MODE_PREVIEWS.rendered,
                ...currentTag(displayConfig.mode === "rendered"),
              },
              {
                name: "Quiet (suppress output, for cron/background)",
                value: "quiet",
                preview: OUTPUT_MODE_PREVIEWS.quiet,
                ...currentTag(displayConfig.mode === "quiet"),
              },
            ],
          });
          if (mode) {
            yield* configService.set("output.mode", mode);
            yield* terminal.success(`Output mode set to ${mode}.`);
          }
          break;
        }
        case "color-profile": {
          const profile = yield* terminal.select<"auto" | ColorProfile>("Select color profile:", {
            default: colorProfileLabel,
            choices: [
              {
                name: "Auto (default)",
                value: "auto",
                preview: COLOR_PROFILE_PREVIEWS.auto,
                ...currentTag(colorProfileLabel === "auto"),
              },
              {
                name: "Full",
                value: "full",
                preview: COLOR_PROFILE_PREVIEWS.full,
                ...currentTag(colorProfileLabel === "full"),
              },
              {
                name: "Basic",
                value: "basic",
                preview: COLOR_PROFILE_PREVIEWS.basic,
                ...currentTag(colorProfileLabel === "basic"),
              },
              {
                name: "None",
                value: "none",
                preview: COLOR_PROFILE_PREVIEWS.none,
                ...currentTag(colorProfileLabel === "none"),
              },
            ],
          });
          if (profile) {
            if (profile === "auto") {
              yield* configService.set("output.colorProfile", undefined);
              yield* terminal.success("Color profile set to auto.");
            } else {
              yield* configService.set("output.colorProfile", profile);
              yield* terminal.success(`Color profile set to ${profile}.`);
            }
          }
          break;
        }
        case "theme": {
          if (terminal.isInteractive && activeKeymapMode() === "fullscreen") {
            const chosen = yield* Effect.promise(() => pickThemeInteractively());
            if (chosen !== undefined) {
              yield* commitTheme(terminal, chosen);
            }
          } else {
            yield* terminal.info("Run /theme in chat to preview and switch themes.");
          }
          break;
        }
        case "show-reasoning": {
          yield* handleBooleanToggle({
            prompt: "Show reasoning output?",
            currentValue: displayConfig.showReasoning,
            configKey: "output.showReasoning",
            label: "Show reasoning",
          });
          break;
        }
        case "collapse-reasoning": {
          const choice = yield* terminal.select<"collapse" | "always">(
            "How should reasoning display after the model finishes thinking?",
            {
              choices: [
                {
                  name: "Collapse after thinking (Ctrl+R to expand)",
                  value: "collapse",
                },
                {
                  name: "Always show reasoning",
                  value: "always",
                },
              ],
            },
          );
          if (choice) {
            const collapse = choice === "collapse";
            yield* configService.set("output.collapseReasoning", collapse);
            yield* terminal.success(
              collapse
                ? "Reasoning will collapse after thinking. Ctrl+R expands it."
                : "Reasoning will stay visible. Ctrl+R is not needed.",
            );
          }
          break;
        }
        case "show-tool-execution": {
          yield* handleBooleanToggle({
            prompt: "Show tool execution?",
            currentValue: displayConfig.showToolExecution,
            configKey: "output.showToolExecution",
            label: "Show tool execution",
          });
          break;
        }
        case "show-metrics": {
          yield* handleBooleanToggle({
            prompt: "Show performance metrics?",
            currentValue: showMetrics,
            configKey: "output.showMetrics",
            label: "Show metrics",
          });
          break;
        }
      }

      yield* terminal.log("");
    }
  });
}

function configureScheduler() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const appConfig = yield* configService.appConfig;
      const currentMode = appConfig.scheduler?.mode ?? "auto";

      const selection = yield* terminal.select<string>(
        "Scheduler settings: what starts your unattended goals and loops on schedule.",
        {
          choices: [
            { name: `Auto${currentMode === "auto" ? " (current)" : ""}`, value: "auto" },
            {
              name: `In-process${currentMode === "in-process" ? " (current)" : ""}`,
              value: "in-process",
            },
            { name: "Back", value: "back" },
          ],
        },
      );

      if (!selection || selection === "back") {
        break;
      }

      const mode = selection as SchedulerMode;
      yield* configService.set("scheduler.mode", mode);
      yield* terminal.success(`Scheduler mode set to ${mode}.`);
      yield* terminal.log("");
      break;
    }
  });
}

const TERMINAL_NOTIFICATION_CHOICES: readonly {
  readonly name: string;
  readonly value: TerminalNotificationSetting;
}[] = [
  { name: "auto: detect kitty, Ghostty, WezTerm, Warp or iTerm2", value: "auto" },
  { name: "osc99: kitty's notification sequence", value: "osc99" },
  { name: "osc777: Ghostty, WezTerm, Warp", value: "osc777" },
  { name: "osc9: iTerm2", value: "osc9" },
  { name: "off: always use the system notifier", value: "off" },
];

function configureNotifications() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const appConfig = yield* configService.appConfig;
      const enabled = appConfig.notifications?.enabled ?? true;
      const sound = appConfig.notifications?.sound ?? true;
      const terminalSetting = appConfig.notifications?.terminal ?? "auto";

      const selection = yield* terminal.select<string>("Notification settings:", {
        choices: [
          { name: `System notifications (${enabled ? "on" : "off"})`, value: "enabled" },
          { name: `Notification sound (${sound ? "on" : "off"})`, value: "sound" },
          { name: `Terminal notifications (${terminalSetting})`, value: "terminal" },
          { name: "Back", value: "back" },
        ],
      });

      if (!selection || selection === "back") {
        break;
      }

      switch (selection) {
        case "enabled": {
          const nextValue = yield* terminal.confirm("Enable system notifications?", enabled);
          if (nextValue === undefined) {
            break;
          }
          yield* configService.set("notifications.enabled", nextValue);
          yield* terminal.success(`System notifications ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
        case "sound": {
          const nextValue = yield* terminal.confirm("Enable notification sound?", sound);
          if (nextValue === undefined) {
            break;
          }
          yield* configService.set("notifications.sound", nextValue);
          yield* terminal.success(`Notification sound ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
        case "terminal": {
          const nextValue = yield* terminal.select<TerminalNotificationSetting>(
            "How should notifications reach your terminal?",
            {
              choices: TERMINAL_NOTIFICATION_CHOICES,
              default: terminalSetting,
            },
          );
          if (nextValue === undefined) {
            break;
          }
          yield* configService.set("notifications.terminal", nextValue);
          yield* terminal.success(`Terminal notifications set to ${nextValue}.`);
          break;
        }
      }

      yield* terminal.log("");
    }
  });
}

/**
 * Daily and monthly dollar caps for goals and for all unattended work (`daemon.*`), plus a
 * default per-session cap for chat (`chat.defaultCostLimitUSD`). Each is unlimited until set.
 * A reached daemon cap stops the unattended work it covers from starting; a reached chat cap
 * asks before continuing, same as `/limit`.
 */
function configureSpendLimits() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const config = yield* configService.appConfig;
      const selection = yield* terminal.select<string>(
        "Spend limits: unattended work stops at its cap; chat asks before continuing past its own.",
        {
          choices: [
            ...SPEND_LIMIT_SETTINGS.map((setting) => ({
              name: `${setting.label} (${describeSpendLimit(setting.read(config))})`,
              value: setting.key,
            })),
            { name: "Back", value: "back" },
          ],
        },
      );
      const setting = SPEND_LIMIT_SETTINGS.find((candidate) => candidate.key === selection);
      if (setting === undefined) {
        break;
      }

      const current = setting.read(config);
      const raw = yield* terminal.ask(`${setting.label}, in USD (leave empty for unlimited):`, {
        simple: true,
        cancellable: true,
        ...(current !== undefined ? { defaultValue: String(current) } : {}),
        validate: (input) => {
          const parsed = parseSpendLimitInput(input);
          return parsed.kind === "invalid" ? parsed.message : true;
        },
      });
      if (raw === undefined) {
        continue;
      }
      const parsed = parseSpendLimitInput(raw);
      if (parsed.kind === "invalid") {
        yield* terminal.warn(parsed.message);
        continue;
      }
      yield* applySpendLimit(configService, setting.key, parsed);
      yield* terminal.success(
        `${setting.label}: ${parsed.kind === "limit" ? describeSpendLimit(parsed.dollars) : "unlimited"}.`,
      );
      yield* terminal.log("");
    }
  });
}

function configurePrivateHosts() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const hosts = (yield* configService.appConfig).network?.allowPrivateHosts ?? [];
      const selection = yield* terminal.select<string>(
        "Private network hosts agents reach without asking (any other local address asks first, and approving adds it here):",
        {
          choices: [
            ...hosts.map((host) => ({ name: `${host} (remove)`, value: `remove:${host}` })),
            { name: "Add a host", value: "add" },
            { name: "Back", value: "back" },
          ],
        },
      );
      if (selection === undefined || selection === "back") {
        break;
      }

      if (selection === "add") {
        const raw = yield* terminal.ask(
          "Host (homeassistant.local, *.lan, 192.168.1.10 or 192.168.1.0/24):",
          {
            simple: true,
            cancellable: true,
            validate: (input) => {
              const result = addPrivateHost(hosts, input);
              return result.kind === "invalid" ? result.message : true;
            },
          },
        );
        if (raw === undefined) {
          continue;
        }
        const result = addPrivateHost(hosts, raw);
        if (result.kind === "invalid") {
          yield* terminal.warn(result.message);
          continue;
        }
        yield* applyPrivateHosts(configService, result.hosts);
        yield* terminal.success(`Agents can now reach ${raw.trim()} without asking.`);
        yield* terminal.log("");
        continue;
      }

      const host = selection.slice("remove:".length);
      yield* applyPrivateHosts(configService, removePrivateHost(hosts, host));
      yield* terminal.success(`Removed ${host}. Reaching it asks for approval again.`);
      yield* terminal.log("");
    }
  });
}

function configureLogging() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const appConfig = yield* configService.appConfig;
      const currentFormat = appConfig.logging?.format ?? "plain";

      const selection = yield* terminal.select<string>(
        "Logging settings: how diagnostic logs are written to the logs directory on disk.",
        {
          choices: [
            { name: `Log format (${currentFormat})`, value: "format" },
            { name: "Back", value: "back" },
          ],
        },
      );

      if (!selection || selection === "back") {
        break;
      }

      if (selection === "format") {
        const nextFormat = yield* terminal.select<LoggingConfig["format"]>("Select log format:", {
          default: currentFormat,
          choices: [
            {
              name: "Plain (human readable)",
              value: "plain",
              preview: LOG_FORMAT_PREVIEWS.plain,
              ...currentTag(currentFormat === "plain"),
            },
            {
              name: "JSON (structured for log processors)",
              value: "json",
              preview: LOG_FORMAT_PREVIEWS.json,
              ...currentTag(currentFormat === "json"),
            },
          ],
        });

        if (nextFormat) {
          yield* configService.set("logging.format", nextFormat);
          yield* terminal.success(`Log format set to ${nextFormat}.`);
        }
      }

      yield* terminal.log("");
    }
  });
}

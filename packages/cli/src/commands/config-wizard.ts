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
import type { TerminalService } from "@jazz/core/interfaces/terminal";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { resolveDisplayConfig } from "@jazz/core/presentation/display-config";
import type {
  LoggingConfig,
  SchedulerMode,
  TerminalNotificationSetting,
  WebSearchProviderName,
} from "@jazz/core/types/config";
import type { ColorProfile, OutputMode } from "@jazz/core/types/output";
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
import { signInToChatGPT, signOutOfChatGPT } from "../helpers/chatgpt-sign-in";
import { isValidServerAddress } from "../helpers/local-provider-url";
import { writeClipboard } from "../ui/fullscreen/clipboard";
import { store } from "../ui/store";
import type { WizardMenuOption } from "../ui/WizardHome";

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
      const menuOptions: WizardMenuOption[] = [
        { label: "LLM Providers", value: "llm-providers" },
        { label: "Web Search Providers", value: "web-search" },
        { label: "Output & Display", value: "output-display" },
        { label: "Scheduler", value: "scheduler" },
        { label: "Logging", value: "logging" },
        { label: "Notifications", value: "notifications" },
        { label: "Spend Limits", value: "spend-limits" },
        { label: "Private Network Hosts", value: "private-hosts" },
        { label: "Back to Main Menu", value: "back" },
      ];

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

function showConfigMenu(
  options: WizardMenuOption[],
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
          const serverKey = yield* terminal.password(
            `${providerDisplay} server API key (only if it runs with --api-key; leave empty to keep current):`,
          );
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
          const cloudKey = yield* terminal.password(
            "Ollama Cloud API key (only for :cloud models; leave empty to keep current):",
          );
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

      const apiKey = yield* terminal.password(
        `Enter API Key for ${providerDisplay} (leave empty to keep current):`,
      );

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
        const apiKey = yield* terminal.password(
          `Enter API Key for ${provider} (leave empty to keep current):`,
        );

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
            choices: [
              { name: "Hybrid (styled, copy-paste friendly)", value: "hybrid" },
              { name: "Raw (plain text)", value: "raw" },
              { name: "Rendered (styled)", value: "rendered" },
              { name: "Quiet (suppress output, for cron/background)", value: "quiet" },
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
            choices: [
              { name: "Auto (default)", value: "auto" },
              { name: "Full", value: "full" },
              { name: "Basic", value: "basic" },
              { name: "None", value: "none" },
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

      const selection = yield* terminal.select<string>("Scheduler settings:", {
        choices: [
          { name: `Auto${currentMode === "auto" ? " (current)" : ""}`, value: "auto" },
          {
            name: `In-process${currentMode === "in-process" ? " (current)" : ""}`,
            value: "in-process",
          },
          { name: "Back", value: "back" },
        ],
      });

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
 * Daily and monthly dollar caps for goals and for all unattended work (`daemon.*`), unlimited
 * until set. A reached cap stops the unattended work it covers from starting; chat never counts.
 */
function configureSpendLimits() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const caps = (yield* configService.appConfig).daemon;
      const selection = yield* terminal.select<string>(
        "Spend limits (a reached limit stops unattended work until it clears; chat is never capped):",
        {
          choices: [
            ...SPEND_LIMIT_SETTINGS.map((setting) => ({
              name: `${setting.label} (${describeSpendLimit(setting.read(caps))})`,
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

      const current = setting.read(caps);
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

      const selection = yield* terminal.select<string>("Logging settings:", {
        choices: [
          { name: `Log format (${currentFormat})`, value: "format" },
          { name: "Back", value: "back" },
        ],
      });

      if (!selection || selection === "back") {
        break;
      }

      if (selection === "format") {
        const nextFormat = yield* terminal.select<LoggingConfig["format"]>("Select log format:", {
          choices: [
            { name: "Plain (human readable)", value: "plain" },
            { name: "JSON (structured for log processors)", value: "json" },
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

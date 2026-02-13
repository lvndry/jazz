import { Effect } from "effect";
import React from "react";
import {
  WEB_SEARCH_PROVIDERS,
  type WebSearchProviderName,
} from "@/core/agent/tools/web-search-tools";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@/core/constants/models";
import { formatProviderDisplayName } from "@/core/utils/string";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { ColorProfile, OutputMode } from "@/core/types/output";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { store } from "../ui/store";
import { WizardHome, type WizardMenuOption } from "../ui/WizardHome";

/**
 * Menu actions for the config wizard
 */
type ConfigMenuAction =
  | "llm-providers"
  | "web-search"
  | "output-display"
  | "logging"
  | "notifications"
  | "back";

/**
 * Main entry point for the configuration wizard
 */
export function configWizardCommand() {
  return Effect.gen(function* () {
    let stayInMenu = true;

    while (stayInMenu) {
      const menuOptions: WizardMenuOption[] = [
        { label: "LLM Providers (API Keys)", value: "llm-providers" },
        { label: "Web Search Providers", value: "web-search" },
        { label: "Output & Display", value: "output-display" },
        { label: "Logging", value: "logging" },
        { label: "Notifications", value: "notifications" },
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
        case "logging": {
          yield* configureLogging();
          break;
        }
        case "notifications": {
          yield* configureNotifications();
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
    store.setCustomView(
      React.createElement(WizardHome, {
        options,
        title: "Configuration",
        onSelect: (value: string) => {
          store.setCustomView(null);
          resume(Effect.succeed(value as ConfigMenuAction));
        },
        onExit: () => {
          store.setCustomView(null);
          resume(Effect.succeed("back" as ConfigMenuAction));
        },
      }),
    );
  });
}

function configureLLMProviders() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      // Get current config to show status
      const config = yield* configService.appConfig;

      const choices: { name: string; value: ProviderName | "back" }[] = AVAILABLE_PROVIDERS.map(
        (p) => {
          const hasKey = !!config.llm?.[p]?.api_key;
          return {
            name: `${formatProviderDisplayName(p)} ${hasKey ? "(configured)" : ""}`,
            value: p,
          };
        },
      );

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
      const apiKey = yield* terminal.password(
        `Enter API Key for ${providerDisplay} (leave empty to keep current):`,
      );

      if (apiKey.trim()) {
        yield* configService.set(`llm.${provider}.api_key`, apiKey);
        yield* terminal.success(`Configuration for ${providerDisplay} updated.`);
      } else {
        yield* terminal.info("No changes made.");
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
            value: p.value as string,
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
        const apiKey = yield* terminal.password(
          `Enter API Key for ${provider} (leave empty to keep current):`,
        );

        if (apiKey.trim()) {
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
            name: `Show thinking (${displayConfig.showThinking ? "on" : "off"})`,
            value: "show-thinking",
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
        case "show-thinking": {
          yield* handleBooleanToggle({
            prompt: "Show thinking output?",
            currentValue: displayConfig.showThinking,
            configKey: "output.showThinking",
            label: "Show thinking",
          });
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

function configureNotifications() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const appConfig = yield* configService.appConfig;
      const enabled = appConfig.notifications?.enabled ?? true;
      const sound = appConfig.notifications?.sound ?? true;

      const selection = yield* terminal.select<string>("Notification settings:", {
        choices: [
          { name: `System notifications (${enabled ? "on" : "off"})`, value: "enabled" },
          { name: `Notification sound (${sound ? "on" : "off"})`, value: "sound" },
          { name: "Back", value: "back" },
        ],
      });

      if (!selection || selection === "back") {
        break;
      }

      switch (selection) {
        case "enabled": {
          const nextValue = yield* terminal.confirm("Enable system notifications?", enabled);
          yield* configService.set("notifications.enabled", nextValue);
          yield* terminal.success(`System notifications ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
        case "sound": {
          const nextValue = yield* terminal.confirm("Enable notification sound?", sound);
          yield* configService.set("notifications.sound", nextValue);
          yield* terminal.success(`Notification sound ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
      }

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
        const nextFormat = yield* terminal.select<"json" | "plain" | "toon">("Select log format:", {
          choices: [
            { name: "Plain (human readable)", value: "plain" },
            { name: "JSON (structured for log processors)", value: "json" },
            { name: "TOON (token-efficient for LLM analysis)", value: "toon" },
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

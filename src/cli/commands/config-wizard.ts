import { Effect } from "effect";
import React from "react";
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderName } from "@/core/agent/tools/web-search-tools";
import { AVAILABLE_PROVIDERS, type ProviderName } from "@/core/constants/models";
import { AgentConfigServiceTag } from "@/core/interfaces/agent-config";
import { TerminalServiceTag } from "@/core/interfaces/terminal";
import type { ColorProfile, OutputMode } from "@/core/types/output";
import { resolveDisplayConfig } from "@/core/utils/display-config";
import { store } from "../ui/App";
import { WizardHome, type WizardMenuOption } from "../ui/WizardHome";

/**
 * Menu actions for the config wizard
 */
type ConfigMenuAction =
  | "llm-providers"
  | "web-search"
  | "output-display"
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
        case "back": {
          stayInMenu = false;
          break;
        }
      }
    }
  });
}

function showConfigMenu(
  options: WizardMenuOption[]
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
      })
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

      const choices: { name: string; value: ProviderName | "back" }[] = AVAILABLE_PROVIDERS.map(p => {
        const hasKey = !!config.llm?.[p]?.api_key;
        return {
          name: `${p} ${hasKey ? "(configured)" : ""}`,
          value: p
        };
      });

      choices.push({ name: "Back", value: "back" });

      const providerChoice = yield* terminal.select<string>("Select provider to configure:", {
        choices
      });

      if (providerChoice === "back") {
        break;
      }

      const provider = providerChoice as ProviderName;

      yield* terminal.info(`Configuring ${provider}...`);
      const apiKey = yield* terminal.password(`Enter API Key for ${provider} (leave empty to keep current):`);

      if (apiKey.trim()) {
        yield* configService.set(`llm.${provider}.api_key`, apiKey);
        yield* terminal.success(`Configuration for ${provider} updated.`);
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

      const choices = WEB_SEARCH_PROVIDERS.map(p => {
        const hasKey = !!config.web_search?.[p.value]?.api_key;
        return {
          name: `${p.name} ${hasKey ? "(configured)" : ""}`,
          value: p.value as string
        };
      });

      choices.push({ name: "Back", value: "back" });

      const providerChoice = yield* terminal.select<string>("Select provider to configure:", {
        choices
      });

      if (providerChoice === "back") {
        break;
      }

      const provider = providerChoice as WebSearchProviderName;

      yield* terminal.info(`Configuring ${provider}...`);
      const apiKey = yield* terminal.password(`Enter API Key for ${provider} (leave empty to keep current):`);

      if (apiKey.trim()) {
        yield* configService.set(`web_search.${provider}.api_key`, apiKey);
        yield* terminal.success(`Configuration for ${provider} updated.`);
      } else {
        yield* terminal.info("No changes made.");
      }

      yield* terminal.log(""); // Spacing
    }
  });
}

function configureOutputDisplay() {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const configService = yield* AgentConfigServiceTag;

    while (true) {
      const appConfig = yield* configService.appConfig;
      const displayConfig = resolveDisplayConfig(appConfig);
      const showMetrics = appConfig.output?.showMetrics ?? true;
      const colorProfileLabel = appConfig.output?.colorProfile ?? "auto";

      const selection = yield* terminal.select<string>("Output & display settings:", {
        choices: [
          { name: `Output mode (${displayConfig.mode})`, value: "mode" },
          { name: `Color profile (${colorProfileLabel})`, value: "color-profile" },
          { name: `Show thinking (${displayConfig.showThinking ? "on" : "off"})`, value: "show-thinking" },
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
              { name: "Raw (copy/paste markdown)", value: "raw" },
              { name: "Markdown (styled)", value: "markdown" },
              { name: "JSON (structured)", value: "json" },
            ],
          });
          if (mode) {
            yield* configService.set("output.mode", mode);
            yield* terminal.success(`Output mode set to ${mode}.`);
          }
          break;
        }
        case "color-profile": {
          const profile = yield* terminal.select<"auto" | ColorProfile>(
            "Select color profile:",
            {
              choices: [
                { name: "Auto (default)", value: "auto" },
                { name: "Full", value: "full" },
                { name: "Basic", value: "basic" },
                { name: "None", value: "none" },
              ],
            },
          );
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
          const nextValue = yield* terminal.confirm(
            "Show thinking output?",
            displayConfig.showThinking,
          );
          yield* configService.set("output.showThinking", nextValue);
          yield* terminal.success(`Show thinking ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
        case "show-tool-execution": {
          const nextValue = yield* terminal.confirm(
            "Show tool execution?",
            displayConfig.showToolExecution,
          );
          yield* configService.set("output.showToolExecution", nextValue);
          yield* terminal.success(`Show tool execution ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
        case "show-metrics": {
          const nextValue = yield* terminal.confirm("Show performance metrics?", showMetrics);
          yield* configService.set("output.showMetrics", nextValue);
          yield* terminal.success(`Show metrics ${nextValue ? "enabled" : "disabled"}.`);
          break;
        }
      }

      yield* terminal.log("");
    }
  });
}

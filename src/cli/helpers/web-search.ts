import { Effect } from "effect";
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderName } from "@/core/agent/tools/web-search-tools";
import { type ProviderName } from "@/core/constants/models";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import { type LLMService } from "@/core/interfaces/llm";
import { type TerminalService } from "@/core/interfaces/terminal";

/**
 * Handle configuration for Web Search tool during agent creation
 *
 * Always prompts user to select a web search provider:
 * - Built-in (if the LLM provider supports native web search)
 * - External providers (Parallel, Exa, Tavily)
 *
 * Returns true if Web Search is successfully configured.
 * Returns false if the user chose to go back/cancel.
 */
export function handleWebSearchConfiguration(
  terminal: TerminalService,
  configService: AgentConfigService,
  llmService: LLMService,
  llmProvider: ProviderName,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const supportsNative = yield* llmService.supportsNativeWebSearch(llmProvider);

    yield* terminal.log("");
    yield* terminal.info("🔍 Configure Web Search Provider");

    // Build provider choices
    const choices: Array<{ name: string; value: WebSearchProviderName | "builtin" | "back" }> = [];

    // Add built-in option first if available
    if (supportsNative) {
      choices.push({
        name: `Built-in (${llmProvider} native search)`,
        value: "builtin",
      });
    }

    // Add external providers
    choices.push(...WEB_SEARCH_PROVIDERS.map(p => ({
      name: p.name,
      value: p.value,
    })));

    // Add go back option
    choices.push({
      name: "Go Back",
      value: "back",
    });

    const selection = yield* terminal.select(
      "Which web search provider would you like to use?",
      { choices }
    );

    if (selection === "back" || !selection) {
      return false;
    }

    if (selection === "builtin") {
      // Clear any external provider setting to use built-in
      yield* configService.set("web_search.provider", undefined);
      yield* terminal.success(`Using built-in web search from ${llmProvider}.`);
      return true;
    }

    // Handle external provider selection
    const provider = selection;
    const hasApiKey = yield* configService.has(`web_search.${provider}.api_key`);

    if (!hasApiKey) {
      // Prompt for API key
      const apiKey = yield* terminal.ask(`Enter API Key for ${provider}:`, {
        validate: (input) => input.trim().length > 0 ? true : "API Key cannot be empty"
      });

      yield* configService.set(`web_search.${provider}.api_key`, apiKey);
      yield* terminal.success(`API Key for ${provider} saved.`);
    }

    // Set the selected provider
    yield* configService.set("web_search.provider", provider);
    yield* terminal.success(`Web search provider set to ${provider}.`);

    return true;
  });
}

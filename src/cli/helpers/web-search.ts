import { Effect } from "effect";
import { WEB_SEARCH_PROVIDERS } from "@/core/agent/tools/web-search-tools";
import { type ProviderName } from "@/core/constants/models";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import { type LLMService } from "@/core/interfaces/llm";
import { type TerminalService } from "@/core/interfaces/terminal";
import type { WebSearchProviderName } from "@/core/types/config";

/**
 * Handle configuration for Web Search tool during agent creation / editing.
 *
 * Prompts the user to select a web search provider:
 * - Built-in (if the LLM provider supports native web search)
 * - External providers (Brave, Parallel, Exa, Tavily, Perplexity)
 *
 * The API key for external providers is stored in the global Jazz config so it
 * is written once and reused across agents.  The provider selection itself is
 * returned to the caller so it can be stored per-agent — this is intentional:
 * different agents can use different providers without clobbering each other.
 *
 * Returns the selected provider (or "builtin"), or false if the user cancelled.
 */
export function handleWebSearchConfiguration(
  terminal: TerminalService,
  configService: AgentConfigService,
  llmService: LLMService,
  llmProvider: ProviderName,
): Effect.Effect<WebSearchProviderName | "builtin" | false, never> {
  return Effect.gen(function* () {
    const supportsNative = yield* llmService.supportsNativeWebSearch(llmProvider);

    yield* terminal.log("");
    yield* terminal.info("🔍 Configure Web Search Provider");

    const choices: Array<{ name: string; value: WebSearchProviderName | "builtin" | "back" }> = [];

    if (supportsNative) {
      choices.push({
        name: `Built-in (${llmProvider} native search)`,
        value: "builtin",
      });
    }

    choices.push(
      ...WEB_SEARCH_PROVIDERS.map((p) => ({
        name: p.name,
        value: p.value,
      })),
    );

    choices.push({
      name: "Go Back",
      value: "back",
    });

    const selection = yield* terminal.select("Which web search provider would you like to use?", {
      choices,
    });

    if (selection === "back" || !selection) {
      return false as const;
    }

    if (selection === "builtin") {
      yield* terminal.success(`Using built-in web search from ${llmProvider}.`);
      return "builtin" as const;
    }

    const provider = selection;
    const hasApiKey = yield* configService.has(`web_search.${provider}.api_key`);

    if (!hasApiKey) {
      const apiKey = yield* terminal.ask(`Enter API Key for ${provider}:`, {
        simple: true,
        secret: true,
        placeholder: "Paste your API key...",
        validate: (input) => (input.trim().length > 0 ? true : "API Key cannot be empty"),
      });

      yield* configService.set(`web_search.${provider}.api_key`, apiKey);
      yield* terminal.success(`API Key for ${provider} saved.`);
    }

    yield* terminal.success(`Web search provider set to ${provider}.`);
    return provider;
  });
}

/**
 * Interactive web-search setup shared by agent creation and editing. configureWebSearch
 * discovers native search support, lets the user pick a primary provider and the providers
 * to fall back to, and prompts for each missing key before persisting it in global
 * configuration. It returns the selection for the caller to store on the agent; cancelling
 * a key prompt or the fallback picker returns to provider selection, and cancelling
 * selection returns false.
 */
import { WEB_SEARCH_PROVIDERS, webSearchProviderLabel } from "@jazz/core/agent/tools/web-search";
import { type ProviderName } from "@jazz/core/constants/models";
import { type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { type LLMService } from "@jazz/core/interfaces/llm";
import {
  type PromptStep,
  type PromptTagTone,
  type TerminalService,
} from "@jazz/core/interfaces/terminal";
import type { WebSearchProviderName } from "@jazz/core/types/config";
import { Effect } from "effect";

/**
 * What the agent should search with.
 *
 * - `default`: no agent setting; the global `web_search.providers`, else every keyed provider.
 * - `builtin`: the model provider's native search (stored as an empty `webSearchProviders`).
 * - `chain`: these providers, in fallback order.
 */
export type WebSearchSelection =
  | { readonly kind: "default" }
  | { readonly kind: "builtin" }
  | { readonly kind: "chain"; readonly providers: readonly WebSearchProviderName[] };

/** The agent's `webSearchProviders` for a selection; undefined clears the field. */
export function webSearchProvidersFor(
  selection: WebSearchSelection,
): readonly WebSearchProviderName[] | undefined {
  switch (selection.kind) {
    case "default":
      return undefined;
    case "builtin":
      return [];
    case "chain":
      return selection.providers;
  }
}

type PrimaryChoice = WebSearchProviderName | "default" | "builtin" | "back";

/**
 * Ask for a provider's key when none is saved. Returns false when the user cancels.
 */
function ensureApiKey(
  terminal: TerminalService,
  configService: AgentConfigService,
  provider: WebSearchProviderName,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (yield* configService.has(`web_search.${provider}.api_key`)) {
      return true;
    }
    const apiKey = yield* terminal.ask(`Enter API Key for ${provider}:`, {
      simple: true,
      secret: true,
      placeholder: "Paste your API key...",
      validate: (input) => (input.trim().length > 0 ? true : "API Key cannot be empty"),
    });
    if (apiKey === undefined) {
      return false;
    }
    yield* configService.set(`web_search.${provider}.api_key`, apiKey);
    yield* terminal.success(`API Key for ${provider} saved.`);
    return true;
  });
}

/**
 * Configure the agent's search providers and shared external-provider credentials.
 *
 * Keys are stored in the global Jazz config so they are entered once and reused across agents;
 * the provider order is returned for the caller to store per agent.
 *
 * Returns the selection, or false if the user cancelled.
 */
export function configureWebSearch(
  terminal: TerminalService,
  configService: AgentConfigService,
  llmService: LLMService,
  llmProvider: ProviderName,
  step?: PromptStep,
): Effect.Effect<WebSearchSelection | false, never> {
  return Effect.gen(function* () {
    const supportsNative = yield* llmService.supportsNativeWebSearch(llmProvider);

    const keySaved = new Set<WebSearchProviderName>();
    for (const provider of WEB_SEARCH_PROVIDERS) {
      if (yield* configService.has(`web_search.${provider.value}.api_key`)) {
        keySaved.add(provider.value);
      }
    }
    const keyTag = (provider: WebSearchProviderName) =>
      keySaved.has(provider)
        ? { tag: "key saved", tagTone: "success" as const }
        : { tag: "needs a key", tagTone: "muted" as const };

    const choices: Array<{
      name: string;
      value: PrimaryChoice;
      tag?: string;
      tagTone?: PromptTagTone;
    }> = [];

    if (keySaved.size > 0) {
      choices.push({
        name: "Default (Jazz-wide web search setting)",
        value: "default",
        tag: [...keySaved].map(webSearchProviderLabel).join(" → "),
        tagTone: "muted",
      });
    }

    if (supportsNative) {
      choices.push({
        name: `Built-in (${llmProvider} native search)`,
        value: "builtin",
      });
    }

    for (const provider of WEB_SEARCH_PROVIDERS) {
      choices.push({ name: provider.name, value: provider.value, ...keyTag(provider.value) });
    }

    choices.push({ name: "Go back to tools", value: "back" });

    while (true) {
      const selection = yield* terminal.select<PrimaryChoice>(
        "Which web search should it use first?",
        {
          choices,
          ...(step === undefined ? {} : { step }),
        },
      );

      if (selection === "back" || !selection) {
        return false as const;
      }

      if (selection === "default") {
        yield* terminal.success("Using the Jazz-wide web search setting.");
        return { kind: "default" } as const;
      }

      if (selection === "builtin") {
        yield* terminal.success(`Using built-in web search from ${llmProvider}.`);
        return { kind: "builtin" } as const;
      }

      const primary = selection;
      if (!(yield* ensureApiKey(terminal, configService, primary))) {
        continue;
      }
      keySaved.add(primary);

      const others = WEB_SEARCH_PROVIDERS.filter((provider) => provider.value !== primary);
      const fallbackSelection = yield* terminal.checkbox<WebSearchProviderName>(
        `Fall back to which providers when ${webSearchProviderLabel(primary)} fails or runs out of quota?`,
        {
          choices: others.map((provider) => ({
            name: provider.name,
            value: provider.value,
            ...keyTag(provider.value),
          })),
          default: others
            .filter((provider) => keySaved.has(provider.value))
            .map((provider) => provider.value),
        },
      );
      if (fallbackSelection === undefined) {
        continue;
      }

      const chain: WebSearchProviderName[] = [primary];
      for (const provider of fallbackSelection) {
        if (yield* ensureApiKey(terminal, configService, provider)) {
          keySaved.add(provider);
          chain.push(provider);
        }
      }

      yield* terminal.success(`Web search: ${chain.map(webSearchProviderLabel).join(" → ")}.`);
      return { kind: "chain", providers: chain } as const;
    }
  });
}

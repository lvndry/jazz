import { Effect } from "effect";
import { type ProviderName } from "@/core/constants/models";
import { type AgentConfigService } from "@/core/interfaces/agent-config";
import { type LLMService } from "@/core/interfaces/llm";
import { type TerminalService } from "@/core/interfaces/terminal";

/**
 * Handle configuration for Web Search tool
 *
 * Returns true if Web Search is successfully configured (natively or via external key).
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
    const hasExaKey = yield* configService.has("web_search.exa.api_key");
    const hasTavilyKey = yield* configService.has("web_search.tavily.api_key");
    const hasParallelKey = yield* configService.has("web_search.parallel.api_key");
    const hasExternalKey = hasExaKey || hasTavilyKey || hasParallelKey;

    if (hasExternalKey) {
       return true;
    }

    if (supportsNative) {
      yield* terminal.info(`Using native web search provided by ${llmProvider}.`);
      return true;
    }

    yield* terminal.warn(`Web Search is NOT natively supported by ${llmProvider}.`);
    yield* terminal.log("You must configure an external provider (Exa, Tavily, or Parallel).");

    const action = yield* terminal.select("Choose an option:", {
      choices: [
        { name: "Configure Exa AI (Recommended)", value: "exa" },
        { name: "Configure Tavily", value: "tavily" },
        { name: "Configure Parallel", value: "parallel" },
        { name: "Go Back (Deselect Search)", value: "back" },
      ],
    });

    if (action === "back" || !action) {
      return false;
    }

    const apiKey = yield* terminal.ask(`Enter API Key for ${action}:`, {
      validate: (input) => input.trim().length > 0 ? true : "API Key cannot be empty"
    });

    yield* configService.set(`web_search.${action}.api_key`, apiKey);
    yield* terminal.success(`API Key for ${action} saved.`);
    return true;
  });
}

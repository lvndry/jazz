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
    // Check if native web search is supported
    const supportsNative = yield* llmService.supportsNativeWebSearch(llmProvider);

    // Check if external keys are configured
    const hasExaKey = yield* configService.has("web_search.exa.api_key");
    const hasTavilyKey = yield* configService.has("web_search.tavily.api_key");
    const hasParallelKey = yield* configService.has("web_search.parallel.api_key");
    const hasExternalKey = hasExaKey || hasTavilyKey || hasParallelKey;

    // If external key exists, we can proceed (native will be overridden if keys exist, or user can rely on keys)
    if (hasExternalKey) {
       // If native supported AND external key exists, warn/inform user?
       // For now, implicit priority (External > Native) is handled in ai-sdk-service.
       // We can just return true.
       return true;
    }

    // If native supported and NO external key -> Default to native, but checking is good practice?
    // User selected "Search". They expect it to work.
    if (supportsNative) {
      // We can just proceed using native.
      // But maybe user WANTS to use external provider?
      // "Web Search is supported natively by ${llmProvider}. Do you want to use that or configure an external provider?"
      // Ideally we just default to native for simplicity unless they want otherwise.
      // Let's prompt only if they might want to add a key.
      // Actually, simplest flow: if native supported, just use it.
      // The user can always go to config to add keys later if they want specific provider features.
      yield* terminal.info(`Using native web search provided by ${llmProvider}.`);
      return true;
    }

    // If native NOT supported and NO external key -> MUST configure external or go back.
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

    // Configure the selected provider
    const apiKey = yield* terminal.ask(`Enter API Key for ${action}:`, {
      validate: (input) => input.trim().length > 0 ? true : "API Key cannot be empty"
    });

    yield* configService.set(`web_search.${action}.api_key`, apiKey);
    yield* terminal.success(`API Key for ${action} saved.`);
    return true;
  });
}

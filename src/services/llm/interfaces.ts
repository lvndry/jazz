import { Context } from "effect";

/**
 * LLM Provider and Service interfaces
 */

import type { LLMProvider, LLMService } from "../../core/interfaces/llm";

export { type LLMProvider, type LLMService };

// Service tag for dependency injection
export const LLMServiceTag = Context.GenericTag<LLMService>("LLMService");

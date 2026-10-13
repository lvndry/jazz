/**
 * @fileoverview Dedicated image models, reached through each provider's image endpoint
 *
 * A chat endpoint cannot run `gpt-image-1.5`, `imagen-4` or `flux-*`: those models answer only
 * on a provider's image-generation endpoint, and a chat request for one fails with "model does
 * not exist". The models.dev catalog cannot tell the two kinds apart — it lists a chat model
 * that can also paint (`gemini-3-pro-image`) and an image-endpoint model (`gpt-image-1.5`) the
 * same way, as outputting images — so the split is by model-id family per provider.
 *
 * Providers without an entry here have no image endpoint in the AI SDK; their image-capable
 * models, if any, are chat models that attach files to a reply (see `generated-files.ts`).
 */

import { createFireworks } from "@ai-sdk/fireworks";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createXai } from "@ai-sdk/xai";
import type { ChatCompletionResponse } from "@jazz/core/types/chat";
import { COMPANION_BRIEF_MARKER } from "@jazz/core/types/llm";
import type { ChatMessage } from "@jazz/core/types/message";
import { generateImage, type ImageModel } from "ai";
import shortUUID from "short-uuid";
import { saveModelGeneratedFiles } from "./generated-files";
import { llmFetch } from "./llm-fetch";

const IMAGE_ENDPOINT_MODEL_FAMILIES: Readonly<Record<string, RegExp>> = {
  openai: /^(gpt-image|chatgpt-image|dall-e)/i,
  gemini: /^imagen-/i,
  xai: /^(grok-imagine|grok-2-image)/i,
  fireworks: /flux|stable-diffusion|sdxl|playground-v2|kolors/i,
  togetherai: /flux|stable-diffusion|sdxl|playground-v2|kolors|imagen/i,
};

/** Whether the model can only be run on its provider's image endpoint. */
export function isImageEndpointModel(provider: string, modelId: string): boolean {
  return IMAGE_ENDPOINT_MODEL_FAMILIES[provider]?.test(modelId) ?? false;
}

/** The provider's image model, or undefined when the SDK has no image endpoint for it. */
export function selectImageModel(
  provider: string,
  modelId: string,
  apiKey: string | undefined,
): ImageModel | undefined {
  const credentials = { ...(apiKey ? { apiKey } : {}), fetch: llmFetch };
  switch (provider) {
    case "openai":
      return createOpenAI(credentials).image(modelId);
    case "gemini":
      return createGoogleGenerativeAI(credentials).image(modelId);
    case "xai":
      return createXai(credentials).image(modelId);
    case "fireworks":
      return createFireworks(credentials).image(modelId);
    case "togetherai":
      return createTogetherAI(credentials).image(modelId);
    default:
      return undefined;
  }
}

/**
 * What the image should depict: the latest user message, reduced to the brief when it is a
 * companion task. The task's rules tell a chat model how to behave; sent to an image endpoint
 * they would be painted into the picture.
 */
export function imagePromptFromMessages(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && message.content.trim().length > 0) {
      const briefStart = message.content.lastIndexOf(COMPANION_BRIEF_MARKER);
      return briefStart === -1
        ? message.content
        : message.content.slice(briefStart + COMPANION_BRIEF_MARKER.length);
    }
  }
  return "";
}

export class ImageGenerationUnsupportedError extends Error {
  constructor(provider: string, modelId: string) {
    super(`${provider} has no image-generation endpoint jazz can reach for ${modelId}.`);
    this.name = "ImageGenerationUnsupportedError";
  }
}

export async function generateImageCompletion(options: {
  readonly provider: string;
  readonly modelId: string;
  readonly apiKey: string | undefined;
  readonly messages: readonly ChatMessage[];
  readonly maxRetries: number;
  readonly abortSignal: AbortSignal;
}): Promise<ChatCompletionResponse> {
  const model = selectImageModel(options.provider, options.modelId, options.apiKey);
  if (model === undefined) {
    throw new ImageGenerationUnsupportedError(options.provider, options.modelId);
  }

  const result = await generateImage({
    model,
    prompt: imagePromptFromMessages(options.messages),
    maxRetries: options.maxRetries,
    abortSignal: options.abortSignal,
  });
  const artifacts = await saveModelGeneratedFiles(result.images, options.modelId);

  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  return {
    id: shortUUID.generate(),
    model: options.modelId,
    content: "",
    finishReason: "stop",
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(result.usage?.inputTokens !== undefined || result.usage?.outputTokens !== undefined
      ? {
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: result.usage?.totalTokens ?? inputTokens + outputTokens,
          },
        }
      : {}),
  };
}

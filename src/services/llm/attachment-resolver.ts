/**
 * @fileoverview Turning attachment paths into payloads a provider request can carry
 *
 * `ChatMessage` stores attachments as paths so conversation history stays small (see
 * `core/types/attachment`). Provider requests need actual payloads, so this module bridges the
 * two immediately before each call.
 *
 * There are two payload shapes, chosen by file size rather than by modality:
 *
 * - **Inline bytes** below `INLINE_BYTE_LIMIT`. Stateless and supported everywhere.
 * - **A provider file reference** above it, obtained via the AI SDK's `uploadFile`. This path
 *   exists because no provider accepts video inline, but keying on size means a very large PDF
 *   uses it too.
 *
 * The upload path is narrower than the inline one, and permanently so: of the providers jazz
 * supports, only OpenAI and Google expose a `files()` API. Anthropic has none. That is
 * survivable because video and audio are Gemini-family capabilities to begin with — but it does
 * mean "attachment too large to inline" is a hard failure on Anthropic rather than a slow path.
 *
 * Uploads are cached for the life of the process. Without the cache, a conversation that
 * references a video would re-upload it on every turn as history replays — slow, and billed
 * per upload on metered providers.
 */

import { readFile, stat } from "node:fs/promises";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { uploadFile } from "ai";
import type { ProviderName } from "@/core/constants/models";
import type { LoggerService } from "@/core/interfaces/logger";
import {
  type MessageAttachment,
  rejectAttachmentReason,
  requiresProviderUpload,
} from "@/core/types/attachment";
import type { LLMConfig } from "@/core/types/config";
import type { ChatMessage } from "@/core/types/message";
import { LLM_PROVIDER_ENV_VARS } from "@/services/secrets/registry";

/**
 * A resolved payload for one attachment: inline bytes, an uploaded provider reference, or a
 * failure explaining why neither could be produced.
 *
 * `unavailable` is a first-class outcome, not an exception. An attachment whose file was moved
 * between the turn that attached it and a later turn that replays history must degrade to a
 * text marker the model can understand — never abort the run.
 */
export type ResolvedAttachment =
  | { readonly kind: "bytes"; readonly data: Uint8Array }
  | { readonly kind: "reference"; readonly reference: unknown }
  | { readonly kind: "unavailable"; readonly reason: string };

/** Keyed by attachment path, which is the identity `toCoreMessages` looks up. */
export type ResolvedAttachments = ReadonlyMap<string, ResolvedAttachment>;

/**
 * The provider's file-upload API, or null when it has none.
 *
 * Typed `unknown` because each provider package declares its own `FilesV4` shape; the AI SDK's
 * `uploadFile` re-narrows it at the call site.
 *
 * Only OpenAI and Google implement `files()` in the AI SDK. `"gemini"` is jazz's name for
 * Google — the provider id and the SDK package name differ here, which is easy to miss.
 */
function resolveFilesApi(providerName: ProviderName, llmConfig?: LLMConfig): unknown {
  const normalized = providerName.toLowerCase();
  const envVar = LLM_PROVIDER_ENV_VARS[providerName];
  const apiKey = llmConfig?.[providerName]?.api_key ?? (envVar ? process.env[envVar] : undefined);

  if (normalized === "openai") {
    return apiKey ? createOpenAI({ apiKey }) : openai;
  }
  if (normalized === "gemini") {
    return apiKey ? createGoogleGenerativeAI({ apiKey }) : google;
  }
  return null;
}

/**
 * Cache key covers size and mtime so editing a file in place invalidates its upload, and the
 * provider so a reference obtained from Google is never handed to OpenAI.
 */
function uploadCacheKey(
  attachment: MessageAttachment,
  modifiedTimeMs: number,
  providerName: string,
): string {
  return `${providerName}:${attachment.path}:${attachment.byteSize}:${modifiedTimeMs}`;
}

const uploadCache = new Map<string, unknown>();

/** Test seam: drops cached references so the next resolve re-uploads. */
export function clearAttachmentUploadCache(): void {
  uploadCache.clear();
}

async function resolveOne(
  attachment: MessageAttachment,
  providerName: ProviderName,
  llmConfig: LLMConfig | undefined,
  logger?: LoggerService,
): Promise<ResolvedAttachment> {
  const rejection = rejectAttachmentReason(attachment);
  if (rejection !== null) {
    return { kind: "unavailable", reason: rejection };
  }

  let modifiedTimeMs: number;
  try {
    modifiedTimeMs = (await stat(attachment.path)).mtimeMs;
  } catch {
    return {
      kind: "unavailable",
      reason: `${attachment.path} could not be read — it was moved or deleted after being attached`,
    };
  }

  if (!requiresProviderUpload(attachment)) {
    try {
      const bytes = await readFile(attachment.path);
      return { kind: "bytes", data: new Uint8Array(bytes) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", reason: `${attachment.path} could not be read: ${detail}` };
    }
  }

  const sizeMb = (attachment.byteSize / (1024 * 1024)).toFixed(1);
  const filesApi = resolveFilesApi(providerName, llmConfig);
  if (filesApi === null) {
    // No inline fallback is possible: the file is over the inline limit by definition.
    return {
      kind: "unavailable",
      reason: `${attachment.path} is ${sizeMb} MB, which must be uploaded rather than inlined, and ${providerName} has no file upload API. Only OpenAI and Gemini support attachments this large.`,
    };
  }

  const cacheKey = uploadCacheKey(attachment, modifiedTimeMs, providerName);
  const cached = uploadCache.get(cacheKey);
  if (cached !== undefined) {
    return { kind: "reference", reference: cached };
  }

  try {
    const bytes = await readFile(attachment.path);
    const uploaded = (await uploadFile({
      api: filesApi as Parameters<typeof uploadFile>[0]["api"],
      data: new Uint8Array(bytes),
      mediaType: attachment.mediaType,
      filename: attachment.path.split("/").pop() ?? "attachment",
    })) as { providerReference: unknown };

    uploadCache.set(cacheKey, uploaded.providerReference);
    void logger?.debug(`Uploaded attachment to provider file API`, {
      path: attachment.path,
      provider: providerName,
      byteSize: attachment.byteSize,
    });
    return { kind: "reference", reference: uploaded.providerReference };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      kind: "unavailable",
      reason: `${attachment.path} is ${sizeMb} MB and uploading it to ${providerName} failed: ${detail}`,
    };
  }
}

/**
 * Resolve every attachment across a message list into a path-keyed map.
 *
 * Deduplicated by path: an image referenced across five replayed turns is read (or uploaded)
 * once per request rather than five times.
 */
export async function resolveAttachments(
  messages: ReadonlyArray<ChatMessage>,
  providerName: ProviderName,
  llmConfig?: LLMConfig,
  logger?: LoggerService,
): Promise<ResolvedAttachments> {
  const byPath = new Map<string, MessageAttachment>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (!byPath.has(attachment.path)) byPath.set(attachment.path, attachment);
    }
  }
  if (byPath.size === 0) return new Map();

  const resolved = new Map<string, ResolvedAttachment>();
  await Promise.all(
    [...byPath.values()].map(async (attachment) => {
      resolved.set(attachment.path, await resolveOne(attachment, providerName, llmConfig, logger));
    }),
  );
  return resolved;
}

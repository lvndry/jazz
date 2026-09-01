/**
 * @fileoverview Turning attachment paths into payloads a provider request can carry
 *
 * `ChatMessage` stores attachments as paths so conversation history stays small (see
 * `core/types/attachment`). Provider requests need actual payloads, so this module bridges the
 * two immediately before each call.
 *
 * There are two payload shapes, chosen by file size rather than by modality:
 *
 * - **An inline base64 string** below `INLINE_BYTE_LIMIT`. Stateless and supported everywhere.
 *   Base64 rather than a `Uint8Array` deliberately: the AI SDK accepts either as `FilePart.data`,
 *   but `ollama-ai-provider-v2` only handles the string form — passing bytes (bare *or* in the
 *   tagged `{ type: 'data' }` wrapper) throws inside its base64 conversion. Cloud providers take
 *   the string just as happily, so one shape serves everything.
 * - **A provider file reference** above it, obtained via the AI SDK's `uploadFile`. This path
 *   exists because no provider accepts video inline, but keying on size means a very large PDF
 *   uses it too.
 *
 * The upload path is narrower than the inline one, and permanently so: of the providers jazz
 * supports, only OpenAI and Google expose a `files()` API. Anthropic has none. That is
 * survivable because video and audio are Gemini-family capabilities to begin with — but it does
 * mean "attachment too large to inline" is a hard failure on Anthropic rather than a slow path.
 *
 * Uploads are retained in a bounded LRU cache. Without the cache, a conversation that
 * references a video would re-upload it on every turn as history replays — slow, and billed
 * per upload on metered providers. The bound prevents inactive conversations from growing a
 * long-lived bot process indefinitely.
 */

import { readFile, stat } from "node:fs/promises";
import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI, openai } from "@ai-sdk/openai";
import { isLocalServerProvider } from "@jazz/core/constants/local-providers";
import type { ProviderName } from "@jazz/core/constants/models";
import type { LoggerService } from "@jazz/core/interfaces/logger";
import {
  type MessageAttachment,
  rejectAttachmentReason,
  requiresProviderUpload,
} from "@jazz/core/types/attachment";
import type { LLMConfig } from "@jazz/core/types/config";
import type { ChatMessage } from "@jazz/core/types/message";
import { uploadFile } from "ai";
import { LLM_PROVIDER_ENV_VARS } from "@/adapters/secrets/registry";

/**
 * A resolved payload for one attachment: inline bytes, an uploaded provider reference, or a
 * failure explaining why neither could be produced.
 *
 * `unavailable` is a first-class outcome, not an exception. An attachment whose file was moved
 * between the turn that attached it and a later turn that replays history must degrade to a
 * text marker the model can understand — never abort the run.
 */
export type ResolvedAttachment =
  | { readonly kind: "inline"; readonly base64: string }
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

/**
 * Maximum provider references retained across active conversations in one process.
 *
 * References are small, opaque provider handles rather than attachment bytes. Still, this is
 * a process-global cache used by long-lived chat bridges, so it needs a firm bound. 256 entries
 * comfortably covers active replayed conversations while ensuring abandoned paths are released.
 */
export const ATTACHMENT_UPLOAD_CACHE_CAPACITY = 256;

/**
 * A minimal insertion-ordered LRU cache for provider upload references.
 *
 * `Map` preserves insertion order. Moving a hit to the end makes its first key the least
 * recently used entry, which can be evicted without timers or background work.
 */
class AttachmentUploadCache {
  private readonly entries = new Map<string, unknown>();

  get(key: string): unknown {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;

    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: unknown): void {
    this.entries.delete(key);
    this.entries.set(key, value);

    if (this.entries.size <= ATTACHMENT_UPLOAD_CACHE_CAPACITY) return;
    const leastRecentlyUsedKey = this.entries.keys().next().value;
    if (leastRecentlyUsedKey !== undefined) this.entries.delete(leastRecentlyUsedKey);
  }

  clear(): void {
    this.entries.clear();
  }
}

const uploadCache = new AttachmentUploadCache();

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
  const isLocal = isLocalServerProvider(providerName);
  const rejection = rejectAttachmentReason(attachment, isLocal);
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

  // A locally-served model has no request-size cap to respect and no file API to upload to, so
  // everything inlines regardless of size.
  if (!requiresProviderUpload(attachment, isLocal)) {
    try {
      const bytes = await readFile(attachment.path);
      return { kind: "inline", base64: bytes.toString("base64") };
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

    // Verified against OpenAI's files API: the result carries providerReference alongside
    // mediaType/filename/providerMetadata/warnings, and providerReference is a per-provider
    // handle ({ openai: "file-…" }) that a model can read a file through. Only the handle is
    // cached — the rest is per-call metadata.
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

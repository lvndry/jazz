import type { ChatId } from "./surface";

/**
 * Incognito chats a bridge keeps a transcript for at once. Each transcript is a whole
 * conversation held only in memory, so a bridge open to many chats needs a firm bound; 64 is far
 * more incognito conversations than one bridge holds open at the same time.
 */
export const INCOGNITO_MAX_CHATS = 64;

/**
 * How long an incognito chat keeps its context without a turn. A day covers picking a
 * conversation back up later the same day; past that it starts fresh, as it does after a restart.
 */
export const INCOGNITO_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

interface Transcript {
  readonly messages: readonly unknown[];
  readonly lastUsedMs: number;
}

export interface IncognitoTranscriptsOptions {
  readonly maxChats?: number;
  readonly idleTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Transcripts for conversations currently incognito, in memory only, so a restart drops the
 * context rather than ever falling back to a file on disk. A chat idle past the TTL starts fresh,
 * and past the cap the least recently used chat is forgotten.
 */
export class IncognitoTranscripts {
  /** Ordered from least to most recently used. */
  private readonly transcripts = new Map<ChatId, Transcript>();
  private readonly maxChats: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(options: IncognitoTranscriptsOptions = {}) {
    this.maxChats = options.maxChats ?? INCOGNITO_MAX_CHATS;
    this.idleTtlMs = options.idleTtlMs ?? INCOGNITO_IDLE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.transcripts.size;
  }

  get(chatId: ChatId): readonly unknown[] {
    const transcript = this.transcripts.get(chatId);
    if (transcript === undefined) {
      return [];
    }
    if (this.now() - transcript.lastUsedMs > this.idleTtlMs) {
      this.transcripts.delete(chatId);
      return [];
    }
    return transcript.messages;
  }

  set(chatId: ChatId, messages: readonly unknown[]): void {
    const now = this.now();
    this.transcripts.delete(chatId);
    this.transcripts.set(chatId, { messages, lastUsedMs: now });
    for (const [oldestChatId, transcript] of this.transcripts) {
      const overCap = this.transcripts.size > this.maxChats;
      if (!overCap && now - transcript.lastUsedMs <= this.idleTtlMs) {
        return;
      }
      this.transcripts.delete(oldestChatId);
    }
  }

  delete(chatId: ChatId): void {
    this.transcripts.delete(chatId);
  }
}

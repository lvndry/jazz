/**
 * Downloading Telegram media (voice notes, audio, photos, video, documents) to local files.
 *
 * The bridge talks to jazz by spawning `jazz run` with a prompt string, so there is no channel
 * for passing bytes. There does not need to be one: jazz ingests attachments by *path*, so a
 * downloaded file's absolute path in the prompt text is all it takes for the agent to receive
 * the actual audio or image. That is why this module's job ends at "file on disk".
 *
 * Keyed on `dataDir` (jazz's home) rather than the bridge config, matching `sessions.ts` and
 * `usage.ts` — these are file-store concerns and shouldn't need the whole bridge to be testable.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Telegram's own hard limit on `getFile` downloads. Larger files simply cannot be fetched
 * through the bot API, so there is no point attempting the download.
 */
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Files older than this are deleted on the next download. See `pruneMediaDir`. */
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;

function mediaDir(dataDir: string): string {
  return join(dataDir, "tg-media");
}

/**
 * Telegram file objects, across the message fields that can carry media.
 *
 * `file_unique_id` is deliberately not used for naming: it is stable across chats, so two chats
 * sending the same file would collide on one local path.
 */
export interface TelegramFileRef {
  readonly file_id?: string;
  readonly file_size?: number;
  readonly mime_type?: string;
  readonly file_name?: string;
  readonly duration?: number;
}

/**
 * A sticker.
 *
 * Static stickers are WebP and video stickers are WebM, both of which a vision model can read.
 * Animated ones are `.tgs` — gzipped Lottie JSON, which is not an image by the time it reaches
 * disk — so `is_animated` is the flag that says "skip this one".
 */
export interface TelegramStickerRef extends TelegramFileRef {
  readonly is_animated?: boolean;
  readonly is_video?: boolean;
  /** The emoji the sticker stands for, which is what a reply to it quotes. */
  readonly emoji?: string;
}

/**
 * The media-bearing fields of a Telegram message.
 *
 * Declared here rather than in the bridge so `extractMedia` can be tested without the bridge:
 * the bridge's own `TelegramMessage` extends this with the text, chat and reply fields.
 */
export interface TelegramMediaFields {
  /** A voice note, i.e. the record button. Always OGG/Opus, never has a filename. */
  readonly voice?: TelegramFileRef;
  /** An audio file sent as music, which Telegram treats separately from a voice note. */
  readonly audio?: TelegramFileRef;
  /**
   * Photos arrive as an array of the same image at several resolutions, smallest first.
   * The last entry is the largest Telegram kept.
   */
  readonly photo?: readonly TelegramFileRef[];
  /** A GIF. Telegram stores these as soundless MP4. */
  readonly animation?: TelegramFileRef;
  /** A video sent from the camera or gallery. */
  readonly video?: TelegramFileRef;
  /** A round video message, i.e. holding the camera button. */
  readonly video_note?: TelegramFileRef;
  readonly sticker?: TelegramStickerRef;
  /** Any file sent as a document, including images sent with "send as file". */
  readonly document?: TelegramFileRef;
}

export interface ExtractedMedia {
  readonly file: TelegramFileRef;
  /** What to ask jazz when the user sent no caption. */
  readonly fallbackInstruction: string;
}

/**
 * Media on a message, plus what to ask jazz when the user sent no caption.
 *
 * Voice notes get an explicit transcribe-and-act instruction because a bare voice note with no
 * caption is the single most common case, and the model needs to know it should act on what was
 * said rather than just describe the audio. Round video messages are the same gesture with a
 * camera, so they get the same treatment.
 *
 * Order is load-bearing in one place: `animation` is checked before `document`, because Telegram
 * repeats a GIF in both fields and the document copy would be taken for an opaque file rather
 * than the video it actually is.
 */
export function extractMedia(message: TelegramMediaFields): ExtractedMedia | undefined {
  if (message.voice !== undefined) {
    return {
      file: message.voice,
      fallbackInstruction:
        "This is a voice message. Listen to it, then do what it asks — or answer it if it is a question.",
    };
  }
  if (message.audio !== undefined) {
    return {
      file: message.audio,
      fallbackInstruction: "Listen to this audio and tell me what is in it.",
    };
  }
  if (message.photo !== undefined && message.photo.length > 0) {
    // Largest available resolution: the smaller entries are thumbnails and would waste the
    // request on an unreadable image.
    const largest = message.photo[message.photo.length - 1];
    if (largest !== undefined) {
      return {
        file: largest,
        fallbackInstruction: "Look at this image and tell me what it shows.",
      };
    }
  }
  if (message.animation !== undefined) {
    return {
      file: message.animation,
      fallbackInstruction: "This is a GIF. Watch it and tell me what happens in it.",
    };
  }
  if (message.video !== undefined) {
    return {
      file: message.video,
      fallbackInstruction: "Watch this video and tell me what is in it.",
    };
  }
  if (message.video_note !== undefined) {
    return {
      file: message.video_note,
      fallbackInstruction:
        "This is a video message. Watch it, then do what it asks — or answer it if it is a question.",
    };
  }
  if (message.sticker !== undefined && message.sticker.is_animated !== true) {
    return {
      file: message.sticker,
      fallbackInstruction: "Look at this sticker and tell me what it shows.",
    };
  }
  if (message.document !== undefined) {
    return {
      file: message.document,
      fallbackInstruction: "Look at this file and tell me what is in it.",
    };
  }
  return undefined;
}

/**
 * Extension for a downloaded file.
 *
 * Telegram's own `file_path` is the most reliable source — it reflects what the file actually
 * is, whereas `mime_type` is client-reported and `file_name` is absent for voice notes. The MIME
 * map covers the case where `file_path` has no extension.
 */
function extensionFor(telegramFilePath: string, mimeType: string | undefined): string {
  const fromPath = telegramFilePath.includes(".")
    ? telegramFilePath.slice(telegramFilePath.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (fromPath.length > 0 && fromPath.length <= 5) return fromPath;

  switch (mimeType) {
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/wav":
      return "wav";
    case "audio/aac":
      return "aac";
    case "audio/flac":
      return "flac";
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return "bin";
  }
}

/**
 * Delete media older than the retention window.
 *
 * Downloaded media accumulates indefinitely otherwise: every voice note ever sent stays on the
 * host. A day is long enough that a path mentioned earlier in a live conversation still
 * resolves, and short enough that the directory does not grow without bound. Jazz itself
 * degrades an unreadable attachment to a text note, so an expired file is not a crash.
 */
function pruneMediaDir(dataDir: string, nowMs: number): void {
  const directory = mediaDir(dataDir);
  if (!existsSync(directory)) return;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    try {
      if (nowMs - statSync(path).mtimeMs > MEDIA_RETENTION_MS) unlinkSync(path);
    } catch {
      // A file vanishing mid-prune is fine; anything else is not worth failing a download over.
    }
  }
}

export type DownloadOutcome =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * Download one Telegram file into `<dataDir>/tg-media` and return its absolute path.
 *
 * The returned path is what goes into the jazz prompt, so it must be absolute — jazz resolves
 * relative attachment paths against the agent's working directory, which is not the bridge's.
 */
export async function downloadTelegramFile(
  botToken: string,
  dataDir: string,
  fileRef: TelegramFileRef,
  chatId: number,
  nowMs: number,
): Promise<DownloadOutcome> {
  const fileId = fileRef.file_id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return { ok: false, reason: "the message had no downloadable file" };
  }
  if (typeof fileRef.file_size === "number" && fileRef.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    const sizeMb = (fileRef.file_size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `the file is ${sizeMb} MB and Telegram's bot API cannot download files over 20 MB`,
    };
  }

  let telegramFilePath: string;
  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getFile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    const body = (await response.json().catch(() => undefined)) as
      { ok?: boolean; result?: { file_path?: string } } | undefined;
    if (body?.ok !== true || typeof body.result?.file_path !== "string") {
      return { ok: false, reason: "Telegram would not provide a download path for the file" };
    }
    telegramFilePath = body.result.file_path;
  } catch (error) {
    return { ok: false, reason: `asking Telegram for the file failed: ${String(error)}` };
  }

  pruneMediaDir(dataDir, nowMs);
  const directory = mediaDir(dataDir);
  mkdirSync(directory, { recursive: true });

  const extension = extensionFor(telegramFilePath, fileRef.mime_type);
  const localPath = join(directory, `${chatId}-${nowMs}.${extension}`);

  try {
    const download = await fetch(`${TELEGRAM_API_BASE}/file/bot${botToken}/${telegramFilePath}`);
    if (!download.ok) {
      return { ok: false, reason: `downloading the file failed with status ${download.status}` };
    }
    await Bun.write(localPath, await download.arrayBuffer());
  } catch (error) {
    return { ok: false, reason: `downloading the file failed: ${String(error)}` };
  }

  return { ok: true, path: localPath };
}

/**
 * The prompt jazz receives for a media message.
 *
 * The path is stated plainly on its own line because jazz's ingestion scans user text for media
 * paths — so mentioning the path *is* the attachment mechanism, not a description of one. The
 * caption (or a default instruction) gives the model something to do with the file; a bare path
 * with no request tends to produce a shrug.
 */
export function buildMediaPrompt(
  localPath: string,
  caption: string | undefined,
  fallbackInstruction: string,
): string {
  const request =
    caption !== undefined && caption.trim().length > 0 ? caption.trim() : fallbackInstruction;
  return `${request}\n\n${localPath}`;
}

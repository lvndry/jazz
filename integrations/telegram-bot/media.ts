/**
 * Downloading Telegram media (voice notes, audio, photos, documents) to local files.
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
      return "m4a";
    case "audio/wav":
      return "wav";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    case "video/mp4":
      return "mp4";
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

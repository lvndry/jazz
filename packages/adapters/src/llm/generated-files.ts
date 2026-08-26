/**
 * @fileoverview Saving media a model produced as part of its response
 *
 * Some chat models return files alongside their text — `gemini-3-pro-image` answers and attaches
 * an image in the same turn. The AI SDK surfaces these on `result.files`, as bytes in memory.
 *
 * Jazz's contract for produced files is a path (see `core/types/artifact`), so these are written
 * to disk here and reported as artifacts. Everything downstream — the printed path, the `--json`
 * envelope, chat bridges — then treats them the same as a rendered PDF, with one difference that
 * matters: `source: "model"`, because pixels a model painted are not the same kind of thing as a
 * chart rendered from HTML the model wrote.
 *
 * These land in jazz's own data directory rather than the working directory, unlike `create_pdf`.
 * A PDF is the thing the user asked for; an image that arrives mid-conversation was not requested
 * by path, and scattering files into whatever directory an agent happens to be in would be a
 * surprise. The path is printed either way.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactKind, GeneratedArtifact } from "@jazz/core/types/artifact";
import { getUserDataDirectory } from "@jazz/core/utils/paths";
import shortUUID from "short-uuid";

/** The subset of the AI SDK's `GeneratedFile` this needs. */
export interface ModelGeneratedFile {
  readonly mediaType: string;
  readonly uint8Array: Uint8Array;
}

function generatedFilesDirectory(): string {
  return join(getUserDataDirectory(), "generated");
}

/**
 * Map an IANA media type onto an artifact kind, or null when it is not media jazz can present.
 *
 * Matching on the top-level segment rather than a fixed list: a model may return any image or
 * audio subtype, and rejecting `image/avif` because it is not on a list would lose a file the
 * user can perfectly well open.
 */
export function artifactKindForMediaType(mediaType: string): ArtifactKind | null {
  const topLevel = mediaType.split("/")[0]?.toLowerCase();
  if (topLevel === "image") return "image";
  if (topLevel === "audio") return "audio";
  if (topLevel === "video") return "video";
  if (mediaType.toLowerCase() === "application/pdf") return "pdf";
  return null;
}

/** File extension for a media type, for a filename that opens in the right application. */
export function extensionForMediaType(mediaType: string): string {
  const subtype = mediaType.split("/")[1]?.toLowerCase() ?? "";
  // Strip parameters and vendor prefixes: "image/svg+xml; charset=utf-8" → "svg".
  const cleaned = subtype.split(";")[0]?.split("+")[0]?.trim() ?? "";
  if (cleaned === "jpeg") return "jpg";
  if (cleaned === "mpeg") return "mp3";
  return cleaned.length > 0 && /^[a-z0-9]{1,6}$/.test(cleaned) ? cleaned : "bin";
}

/**
 * Write the files a model returned and describe them as artifacts.
 *
 * Never throws: a model that produced an image and a disk that would not take it should still
 * yield the model's text answer. A file that cannot be written is skipped, and the caller decides
 * whether the absence is worth mentioning.
 */
export async function saveModelGeneratedFiles(
  files: readonly ModelGeneratedFile[],
  modelId: string,
): Promise<GeneratedArtifact[]> {
  if (files.length === 0) return [];

  const directory = generatedFilesDirectory();
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    return [];
  }

  const artifacts: GeneratedArtifact[] = [];
  for (const file of files) {
    const kind = artifactKindForMediaType(file.mediaType);
    if (kind === null) continue;

    const path = join(
      directory,
      `${shortUUID.generate()}.${extensionForMediaType(file.mediaType)}`,
    );
    try {
      await writeFile(path, file.uint8Array);
    } catch {
      continue;
    }

    artifacts.push({
      kind,
      path,
      mediaType: file.mediaType,
      tool: modelId,
      source: "model",
    });
  }
  return artifacts;
}

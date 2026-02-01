import type { StorageConfig } from "../types";
import { getUserDataDirectory } from "./runtime-detection";

/**
 * Resolve the effective directory that should be used for file-based storage.
 * Falls back to the default data directory when storage is not file-based or
 * when the configured path is empty.
 */
export function resolveStorageDirectory(storage: StorageConfig): string {
  if (storage.type === "file") {
    const trimmed = storage.path?.trim();
    if (trimmed && trimmed.length > 0) {
      return storage.path;
    }
  }

  return getUserDataDirectory();
}

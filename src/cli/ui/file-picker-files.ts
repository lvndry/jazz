import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FilePickerEntry {
  readonly name: string;
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface FilePickerScanOptions {
  readonly basePath: string;
  readonly query: string;
  readonly extensions?: readonly string[];
  readonly includeDirectories: boolean;
  readonly maxResults?: number;
  readonly maxDepth?: number;
}

async function scanDirectory(
  rootPath: string,
  query: string,
  basePath: string,
  extensions: readonly string[] | undefined,
  includeDirectories: boolean,
  maxResults: number,
  maxDepth: number,
): Promise<FilePickerEntry[]> {
  const results: FilePickerEntry[] = [];
  const normalizedQuery = query.toLowerCase();

  async function scan(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth || results.length >= maxResults) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(basePath, fullPath);
      const matches =
        relativePath.toLowerCase().includes(normalizedQuery) ||
        fullPath.toLowerCase().includes(normalizedQuery);

      if (entry.isDirectory()) {
        if (includeDirectories && matches) {
          results.push({ name: relativePath, path: fullPath, isDirectory: true });
        }
        await scan(fullPath, depth + 1);
        continue;
      }

      if (extensions && extensions.length > 0) {
        const extension = path.extname(entry.name).slice(1).toLowerCase();
        if (!extensions.includes(extension)) continue;
      }
      if (matches) results.push({ name: relativePath, path: fullPath, isDirectory: false });
    }
  }

  await scan(rootPath, 0);
  return results;
}

export async function scanFilePickerEntries({
  basePath,
  query,
  extensions,
  includeDirectories,
  maxResults = 100,
  maxDepth = 5,
}: FilePickerScanOptions): Promise<FilePickerEntry[]> {
  if (!path.isAbsolute(query)) {
    return scanDirectory(
      basePath,
      query,
      basePath,
      extensions,
      includeDirectories,
      maxResults,
      maxDepth,
    );
  }

  const queryDirectory = path.dirname(query);
  const queryBase = path.basename(query);
  try {
    if ((await fs.stat(queryDirectory)).isDirectory()) {
      return scanDirectory(
        queryDirectory,
        queryBase,
        basePath,
        extensions,
        includeDirectories,
        maxResults,
        maxDepth,
      );
    }
  } catch {
    return [];
  }
  return [];
}

export async function resolveFilePickerPath(
  basePath: string,
  query: string,
): Promise<string | null> {
  if (query.length === 0) return null;
  const candidate = path.isAbsolute(query) ? query : path.resolve(basePath, query);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

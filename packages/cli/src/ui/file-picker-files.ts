/**
 * Filesystem scanning for the `@`-mention / file-picker overlay: walks
 * `basePath` respecting `.gitignore`, filtering by extension and query.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ignore, { type Ignore } from "ignore";

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

/** Loads `.gitignore` from `basePath`, if there is one. Missing file, no rules. */
async function loadGitignore(basePath: string): Promise<Ignore> {
  const ig = ignore();
  try {
    ig.add(await fs.readFile(path.join(basePath, ".gitignore"), "utf8"));
  } catch {
    // No .gitignore, or unreadable — scan unfiltered by it.
  }
  return ig;
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
  const gitignore = await loadGitignore(basePath);

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
      if (entry.name === ".git" || entry.name === ".env" || entry.name.startsWith(".env.")) {
        continue;
      }
      // Skipped unconditionally rather than left to .gitignore: these directories are
      // large enough that even walking into them before filtering defeats the scan's
      // whole reason for being cheap.
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
        continue;
      }

      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(basePath, fullPath);
      if (relativePath.length > 0 && gitignore.ignores(relativePath)) continue;
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

  // Sort by path depth, then files before directories, then name length, then
  // alphabetically — otherwise `readdir` order determines ranking, which buries a
  // shallow match under any deeper one whose parent directory happened to sort
  // first. Files rank above same-depth directories so a short directory name
  // (e.g. "packages") can't bury the file someone was actually typing toward
  // (e.g. "package.json") just for being a few characters shorter.
  results.sort((left, right) => {
    const depthDelta = left.name.split(path.sep).length - right.name.split(path.sep).length;
    if (depthDelta !== 0) return depthDelta;
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? 1 : -1;
    const lengthDelta = left.name.length - right.name.length;
    if (lengthDelta !== 0) return lengthDelta;
    return left.name.localeCompare(right.name);
  });

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

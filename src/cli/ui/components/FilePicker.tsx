import * as fs from "node:fs";
import * as path from "node:path";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useMemo, useState } from "react";

interface FilePickerProps {
  readonly basePath: string;
  readonly extensions?: readonly string[] | undefined;
  readonly includeDirectories?: boolean | undefined;
  readonly onSelect: (filePath: string) => void;
  readonly onCancel?: (() => void) | undefined;
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * Recursively scan directory for files matching the query and extensions.
 * Limits depth and results to keep UI responsive.
 */
function scanDirectory(
  basePath: string,
  query: string,
  extensions: readonly string[] | undefined,
  includeDirectories: boolean,
  maxResults: number = 100,
  maxDepth: number = 5,
): FileEntry[] {
  const results: FileEntry[] = [];
  const normalizedQuery = query.toLowerCase();

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth || results.length >= maxResults) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      // Skip hidden files/directories
      if (entry.name.startsWith(".")) continue;
      // Skip node_modules and common build directories
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        // Include directory in results if requested and matches query
        // Include directory in results if requested and matches query (full or relative)
        if (includeDirectories && (
          relativePath.toLowerCase().includes(normalizedQuery) ||
          fullPath.toLowerCase().includes(normalizedQuery)
        )) {
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: true,
          });
        }
        // Recurse into subdirectory
        scan(fullPath, depth + 1);
      } else {
        // Check extension filter
        if (extensions && extensions.length > 0) {
          const ext = path.extname(entry.name).slice(1).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }

        // Check if matches query
        // Check if matches query (full or relative)
        if (
          relativePath.toLowerCase().includes(normalizedQuery) ||
          fullPath.toLowerCase().includes(normalizedQuery)
        ) {
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: false,
          });
        }
      }
    }
  }

  scan(basePath, 0);
  return results;
}

/**
 * FilePicker - an interactive file selection component with fuzzy path filtering.
 * Type to filter files, use arrow keys to navigate, Enter to select, Escape to cancel.
 */
export function FilePicker({
  basePath,
  extensions,
  includeDirectories = false,
  onSelect,
  onCancel,
}: FilePickerProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const pageSize = 10;

  // Scan for files matching the query
  const files = useMemo(() => {
    // If query is an absolute path, scan from the parent directory of the path
    if (query.startsWith("/")) {
      // Get the directory part of the absolute path
      const queryDir = path.dirname(query);
      const queryBase = path.basename(query);

      // If the directory exists, scan from there
      if (fs.existsSync(queryDir) && fs.statSync(queryDir).isDirectory()) {
        return scanDirectory(queryDir, queryBase, extensions, includeDirectories);
      }
      // If it's just "/" or the dir doesn't exist, scan from root
      if (query === "/") {
        return scanDirectory("/", "", extensions, includeDirectories);
      }
    }
    return scanDirectory(basePath, query, extensions, includeDirectories);
  }, [basePath, query, extensions, includeDirectories]);

  const effectivePageSize = Math.max(1, Math.min(pageSize, files.length || 1));
  const windowEndExclusive = Math.min(files.length, windowStart + effectivePageSize);
  const hasMoreAbove = windowStart > 0;
  const hasMoreBelow = windowEndExclusive < files.length;

  // Reset cursor and window when query changes
  useEffect(() => {
    setCursorIndex(0);
    setWindowStart(0);
  }, [query]);

  function clampCursor(nextIndex: number): number {
    if (files.length === 0) return 0;
    return Math.max(0, Math.min(files.length - 1, nextIndex));
  }

  function ensureCursorVisible(nextCursor: number): void {
    if (files.length <= effectivePageSize) {
      setWindowStart(0);
      return;
    }

    if (nextCursor < windowStart) {
      setWindowStart(nextCursor);
      return;
    }

    const endInclusive = windowStart + effectivePageSize - 1;
    if (nextCursor > endInclusive) {
      setWindowStart(Math.max(0, nextCursor - (effectivePageSize - 1)));
    }
  }

  function moveCursor(delta: number): void {
    const nextCursor = clampCursor(cursorIndex + delta);
    setCursorIndex(nextCursor);
    ensureCursorVisible(nextCursor);
  }

  function submit(): void {
    // First, try to select from the filtered results list (user selected with arrow keys)
    const selected = files[cursorIndex];
    if (selected) {
      onSelect(selected.path);
      return;
    }

    // If no files in list, check if the query itself is a valid path (direct entry)
    if (query) {
      // Try as absolute path
      if (path.isAbsolute(query) && fs.existsSync(query)) {
        onSelect(query);
        return;
      }
      // Try as relative to basePath
      const resolvedPath = path.resolve(basePath, query);
      if (fs.existsSync(resolvedPath)) {
        onSelect(resolvedPath);
        return;
      }
    }
  }

  useInput((input, key) => {
    // Handle escape for cancellation
    if (key.escape) {
      onCancel?.();
      return;
    }

    // Navigation
    if (key.upArrow) {
      moveCursor(-1);
      return;
    }

    if (key.downArrow) {
      moveCursor(1);
      return;
    }

    // Selection
    if (key.return) {
      submit();
      return;
    }

    // Tab for autocomplete to common prefix
    if (key.tab && files.length > 0) {
      const selected = files[cursorIndex];
      if (selected) {
        // Set query to the relative path of selected item
        const relativePath = path.relative(basePath, selected.path);
        setQuery(relativePath);
      }
      return;
    }

    // Backspace handling
    if (key.backspace || key.delete) {
      setQuery((prev) => prev.slice(0, -1));
      return;
    }

    // Text input - only printable characters
    if (input && !key.ctrl && !key.meta) {
      setQuery((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Search input */}
      <Box>
        <Text color="gray">Path: </Text>
        <Text color="cyan">{query}</Text>
        <Text color="gray">│</Text>
      </Box>

      {/* Base path info */}
      <Box marginTop={1}>
        <Text dimColor>
          Base: {basePath}
        </Text>
      </Box>

      {/* Results count */}
      <Box>
        <Text dimColor>
          {files.length} files found
          {hasMoreAbove || hasMoreBelow ? " (↑/↓ to scroll)" : ""}
        </Text>
      </Box>

      {/* Scroll indicator - top */}
      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {/* Files list */}
      {files.length === 0 ? (
        <Text dimColor>(No matching files)</Text>
      ) : (
        files.slice(windowStart, windowEndExclusive).map((file, localIndex) => {
          const absoluteIndex = windowStart + localIndex;
          const isActive = absoluteIndex === cursorIndex;
          const relativePath = path.relative(basePath, file.path);
          const icon = file.isDirectory ? "📁 " : "📄 ";

          return (
            <Text
              key={absoluteIndex}
              {...(isActive ? { color: "green" as const, bold: true as const } : {})}
            >
              {isActive ? "> " : "  "}{icon}{relativePath}
            </Text>
          );
        })
      )}

      {/* Scroll indicator - bottom */}
      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>Type to filter · ↑/↓ navigate · Tab autocomplete · Enter select · Esc cancel</Text>
      </Box>
    </Box>
  );
}

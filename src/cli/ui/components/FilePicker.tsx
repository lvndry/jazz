import * as path from "node:path";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import {
  type FilePickerEntry,
  resolveFilePickerPath,
  scanFilePickerEntries,
} from "../file-picker-files";
import { THEME } from "../theme";

interface FilePickerProps {
  readonly basePath: string;
  readonly extensions?: readonly string[] | undefined;
  readonly includeDirectories?: boolean | undefined;
  readonly onSelect: (filePath: string) => void;
  readonly onCancel?: (() => void) | undefined;
}

/**
 * Interactive file selection with path filtering.
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
  const [files, setFiles] = useState<FilePickerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const pageSize = 10;

  // Scan for files matching the query asynchronously
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    async function doScan() {
      const result = await scanFilePickerEntries({
        basePath,
        query,
        ...(extensions === undefined ? {} : { extensions }),
        includeDirectories,
      });

      if (!cancelled) {
        setFiles(result);
        setIsLoading(false);
      }
    }

    void doScan();
    return () => {
      cancelled = true;
    };
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

  const [submitError, setSubmitError] = useState("");

  async function submit(): Promise<void> {
    setSubmitError("");

    // First, try to select from the filtered results list (user selected with arrow keys)
    const selected = files[cursorIndex];
    if (selected) {
      onSelect(selected.path);
      return;
    }

    // If no files in list, check if the query itself is a valid path (direct entry)
    if (query) {
      const resolvedPath = await resolveFilePickerPath(basePath, query);
      if (resolvedPath !== null) {
        onSelect(resolvedPath);
        return;
      }
      setSubmitError(`No file found: ${query}`);
      return;
    }

    setSubmitError("No file selected");
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
      void submit();
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
        <Text color={THEME.muted}>Path: </Text>
        <Text color={THEME.primary}>{query}</Text>
        <Text color={THEME.muted}>│</Text>
      </Box>

      {/* Base path info */}
      <Box marginTop={1}>
        <Text dimColor>Base: {basePath}</Text>
      </Box>

      {/* Results count */}
      <Box>
        <Text dimColor>
          {isLoading ? "Scanning..." : `${files.length} files found`}
          {hasMoreAbove || hasMoreBelow ? " (↑/↓ to scroll)" : ""}
        </Text>
      </Box>

      {/* Scroll indicator - top */}
      {hasMoreAbove && <Text dimColor>↑ more</Text>}

      {/* Files list */}
      {files.length === 0 ? (
        <Text dimColor>{isLoading ? "Loading..." : "(No matching files)"}</Text>
      ) : (
        files.slice(windowStart, windowEndExclusive).map((file, localIndex) => {
          const absoluteIndex = windowStart + localIndex;
          const isActive = absoluteIndex === cursorIndex;
          const relativePath = path.relative(basePath, file.path);
          const icon = file.isDirectory ? "📁 " : "📄 ";

          return (
            <Text
              key={file.path}
              {...(isActive ? { color: THEME.selected, bold: true as const } : {})}
            >
              {isActive ? "> " : "  "}
              {icon}
              {relativePath}
            </Text>
          );
        })
      )}

      {/* Scroll indicator - bottom */}
      {hasMoreBelow && <Text dimColor>↓ more</Text>}

      {/* Error message */}
      {submitError && (
        <Box>
          <Text color={THEME.error}>{submitError}</Text>
        </Box>
      )}

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          Type to filter · ↑/↓ navigate · Tab autocomplete · Enter select · Esc cancel
        </Text>
      </Box>
    </Box>
  );
}

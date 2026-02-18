/**
 * Tool Result Formatter
 *
 * Formats tool results for LLM context by stripping noise while preserving signal.
 * Two-phase approach:
 *   Phase 1 — Lossless noise stripping: remove input echoes, derivable fields,
 *             duplicate representations, and constant/diagnostic fields.
 *   Phase 2 — Structure-aware truncation: only when the stripped result exceeds
 *             a per-tool character budget, truncate by removing complete entries
 *             (array items, lines) rather than slicing mid-structure.
 *
 * Design principles:
 *   - Small results pass through raw — don't reformat what's already efficient.
 *   - No wrapper metadata — the LLM already knows what tool it called.
 *   - Tool-aware stripping preserves the fields the LLM needs for its next decision.
 *   - Skills (load_skill, load_skill_section) always pass through in full.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default character budget for serialized tool results. */
const DEFAULT_MAX_CHARS = 12_000;

/**
 * Per-tool max chars. Tools with typically large output get higher budgets.
 * Tools not listed here use DEFAULT_MAX_CHARS.
 */
const TOOL_MAX_CHARS: Readonly<Record<string, number>> = {
  read_file: 24_000,
  read_pdf: 24_000,
  head: 16_000,
  tail: 16_000,
  git_diff: 16_000,
  execute_command: 16_000,
  http_request: 16_000,
  grep: 12_000,
  git_log: 12_000,
  git_blame: 12_000,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A function that strips noise from a specific tool's result object in place. */
type StripFn = (result: Record<string, unknown>) => void;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "Failed to serialize tool result" });
  }
}

/**
 * Delete multiple keys from an object.
 */
function deleteKeys(obj: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    delete obj[key];
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Per-tool noise strippers
// ---------------------------------------------------------------------------

/**
 * grep — strip input echoes, derivable fields, diagnostic.
 * Keep: matches/files/counts (core data), searchPath (useful context).
 */
function stripGrep(r: Record<string, unknown>): void {
  // Input echoes
  deleteKeys(r, [
    "pattern",
    "recursive",
    "regex",
    "ignoreCase",
    "filePattern",
    "exclude",
    "excludeDir",
    "contextLines",
    "outputMode",
  ]);
  // Derivable
  deleteKeys(r, ["totalFound", "message"]);
  // Diagnostic
  delete r["backend"];
}

/**
 * read_file — strip constant encoding, derivable line counts.
 * Keep: path, content, truncated (signals whether re-read needed), range.
 */
function stripReadFile(r: Record<string, unknown>): void {
  deleteKeys(r, ["encoding", "totalLines", "returnedLines"]);
}

/**
 * edit_file — strip derivable totalEdits, duplicate fullDiff.
 * Keep: path, editsApplied, originalLines, newLines, diff.
 */
function stripEditFile(r: Record<string, unknown>): void {
  deleteKeys(r, ["totalEdits", "fullDiff", "wasTruncated"]);
}

/**
 * ls — strip derivable name (last segment of path) from each entry.
 * Result is an array, handled specially.
 */
function stripLsEntry(entry: Record<string, unknown>): void {
  delete entry["name"];
}

/**
 * find — same as ls.
 */
function stripFindEntry(entry: Record<string, unknown>): void {
  delete entry["name"];
}

/**
 * head — strip input echo and derivable fields.
 * Keep: path, content.
 */
function stripHead(r: Record<string, unknown>): void {
  deleteKeys(r, ["requestedLines", "totalLines", "returnedLines", "truncated"]);
}

/**
 * tail — strip input echo and derivable fields.
 * Keep: path, content, startLine (useful to know position in file).
 */
function stripTail(r: Record<string, unknown>): void {
  deleteKeys(r, ["requestedLines", "totalLines", "returnedLines", "truncated", "endLine"]);
}

/**
 * read_pdf — strip constant fileType, derivable totalLines/truncated.
 * Keep: path, content, pageCount, tables.
 * Drop pagesExtracted (echo of input).
 */
function stripReadPdf(r: Record<string, unknown>): void {
  deleteKeys(r, ["fileType", "totalLines", "truncated", "pagesExtracted"]);
  // tables duplicate content that's already rendered as markdown in `content`.
  // Only strip if content is present (tables are rendered inline).
  if (typeof r["content"] === "string" && r["content"].length > 0) {
    delete r["tables"];
  }
}

/**
 * git_diff — strip input echo (options), derivable fields.
 * Keep: workingDirectory, paths (scoped files), diff.
 */
function stripGitDiff(r: Record<string, unknown>): void {
  deleteKeys(r, ["options", "hasChanges", "truncated", "totalLines", "returnedLines"]);
}

/**
 * git_log — strip derivable commitCount; per-commit strip shortHash, oneline.
 * Keep: workingDirectory, commits[].{hash, author, relativeDate, subject}.
 */
function stripGitLog(r: Record<string, unknown>): void {
  delete r["commitCount"];
  const commits = r["commits"];
  if (Array.isArray(commits)) {
    for (const commit of commits) {
      if (isRecord(commit)) {
        deleteKeys(commit, ["shortHash", "oneline"]);
      }
    }
  }
}

/**
 * git_status — strip derivable hasChanges, duplicate rawStatus.
 * Keep: workingDirectory, branch, summary.
 */
function stripGitStatus(r: Record<string, unknown>): void {
  deleteKeys(r, ["hasChanges", "rawStatus"]);
}

/**
 * git_blame — strip input echoes (file, options), derivable lineCount.
 * Keep: workingDirectory, lines[].{commitHash, author, lineNumber, content}.
 */
function stripGitBlame(r: Record<string, unknown>): void {
  deleteKeys(r, ["file", "options", "lineCount"]);
}

/**
 * execute_command — strip input echo (command), derivable success.
 * Keep: workingDirectory, exitCode, stdout, stderr.
 */
function stripExecuteCommand(r: Record<string, unknown>): void {
  deleteKeys(r, ["command", "success"]);
}

/**
 * http_request — strip entire request echo, diagnostic elapsedMs,
 * derivable truncated from response.
 * Keep: response.{status, statusText, headers, body, size}.
 */
function stripHttpRequest(r: Record<string, unknown>): void {
  delete r["request"];
  const response = r["response"];
  if (isRecord(response)) {
    deleteKeys(response, ["elapsedMs", "truncated"]);
  }
}

/**
 * web_search — strip input echo (query), diagnostic (provider, timestamp),
 * derivable totalResults. Strip per-item source (redundant with provider).
 * Keep: results[].{title, url, snippet, publishedDate, metadata}.
 */
function stripWebSearch(r: Record<string, unknown>): void {
  deleteKeys(r, ["query", "provider", "timestamp", "totalResults"]);
  const results = r["results"];
  if (Array.isArray(results)) {
    for (const item of results) {
      if (isRecord(item)) {
        delete item["source"];
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stripper registry
// ---------------------------------------------------------------------------

const STRIPPERS: Readonly<Record<string, StripFn>> = {
  grep: stripGrep,
  read_file: stripReadFile,
  edit_file: stripEditFile,
  execute_edit_file: stripEditFile,
  head: stripHead,
  tail: stripTail,
  read_pdf: stripReadPdf,
  git_diff: stripGitDiff,
  git_log: stripGitLog,
  git_status: stripGitStatus,
  git_blame: stripGitBlame,
  execute_command: stripExecuteCommand,
  execute_execute_command: stripExecuteCommand,
  http_request: stripHttpRequest,
  web_search: stripWebSearch,
};

/** Tools whose array entries should be individually stripped. */
const ARRAY_ENTRY_STRIPPERS: Readonly<Record<string, (entry: Record<string, unknown>) => void>> = {
  ls: stripLsEntry,
  find: stripFindEntry,
};

// ---------------------------------------------------------------------------
// Phase 2: Structure-aware truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a string that represents line-oriented content (code, diffs, logs).
 * Keeps complete lines from the head plus a note about omitted lines.
 */
function truncateLineContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split("\n");
  let charCount = 0;
  let lineCount = 0;
  for (const line of lines) {
    // +1 for the newline
    if (charCount + line.length + 1 > maxChars - 60) break; // reserve space for truncation note
    charCount += line.length + 1;
    lineCount++;
  }
  if (lineCount === 0) {
    // Single very long line — hard slice
    return text.slice(0, maxChars - 30) + `\n[truncated, ${text.length} chars total]`;
  }
  const kept = lines.slice(0, lineCount).join("\n");
  const omitted = lines.length - lineCount;
  return kept + `\n[${omitted} more lines, ${text.length} chars total]`;
}

/**
 * Truncate an array by keeping the first N complete entries that fit within
 * the budget. Appends a count of omitted entries.
 */
function truncateArray(arr: readonly unknown[], maxChars: number): unknown[] {
  const serialized = safeStringify(arr);
  if (serialized.length <= maxChars) return arr as unknown[];

  const result: unknown[] = [];
  // 30 chars reserved for the "[N more items]" trailer
  let budget = maxChars - 30;
  const overhead = 2; // opening [ and closing ]
  budget -= overhead;

  for (const item of arr) {
    const itemStr = safeStringify(item);
    const cost = itemStr.length + (result.length > 0 ? 1 : 0); // comma separator
    if (budget - cost < 0) break;
    budget -= cost;
    result.push(item);
  }

  const omitted = arr.length - result.length;
  if (omitted > 0) {
    result.push(`[${omitted} more items]`);
  }
  return result;
}

/**
 * Given a serialized result that exceeds the budget, attempt structure-aware truncation.
 * Falls back to a hard slice with a note if no better strategy applies.
 */
function truncateResult(
  _toolName: string,
  result: unknown,
  serialized: string,
  maxChars: number,
): string {
  // If the result is a string (some tools return plain strings), truncate by lines
  if (typeof result === "string") {
    return truncateLineContent(result, maxChars);
  }

  // If the result is an array (ls, find), truncate array entries
  if (Array.isArray(result)) {
    return safeStringify(truncateArray(result, maxChars));
  }

  // If the result is an object, look for truncatable fields
  if (isRecord(result)) {
    // Clone to avoid mutating the original
    const clone = { ...result };

    // Try truncating known large string fields (content, diff, stdout, stderr)
    const stringFields = ["content", "diff", "stdout", "stderr"];
    for (const field of stringFields) {
      const val = clone[field];
      if (typeof val === "string" && val.length > 1000) {
        // Estimate how much we need to cut from this field
        const excess = serialized.length - maxChars;
        const targetFieldLen = Math.max(500, val.length - excess - 100);
        clone[field] = truncateLineContent(val, targetFieldLen);
        const recheck = safeStringify(clone);
        if (recheck.length <= maxChars) return recheck;
      }
    }

    // Try truncating known large array fields (matches, commits, lines, results)
    const arrayFields = ["matches", "commits", "lines", "results", "files", "counts", "summary"];
    for (const field of arrayFields) {
      const val = clone[field];
      if (Array.isArray(val) && val.length > 5) {
        const excess = serialized.length - maxChars;
        // Rough estimate: proportionally reduce
        const targetLen = Math.max(safeStringify(val).length - excess - 200, 200);
        clone[field] = truncateArray(val, targetLen);
        const recheck = safeStringify(clone);
        if (recheck.length <= maxChars) return recheck;
      }
    }

    // Last resort: serialize clone and hard-truncate
    const cloneSerialized = safeStringify(clone);
    if (cloneSerialized.length <= maxChars) return cloneSerialized;
  }

  // Fallback: hard slice with note
  return serialized.slice(0, maxChars - 40) + `\n[truncated, ${serialized.length} chars total]`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Format a tool result for inclusion in the LLM's conversation context.
 *
 * @param toolName - The name of the tool that produced the result.
 * @param result   - The unwrapped result value (not the {success, result, error} envelope).
 * @returns A string ready to be used as the `content` of a tool message.
 */
export function formatToolResultForContext(toolName: string, result: unknown): string {
  // Skills always pass through in full — truncating instructions defeats
  // the purpose of loading a skill.
  if (toolName === "load_skill" || toolName === "load_skill_section") {
    return typeof result === "string" ? result : safeStringify(result);
  }

  // Phase 1: Strip noise from object/array results
  let stripped = result;

  if (isRecord(result)) {
    // Shallow clone to avoid mutating the original tool result
    const clone = { ...result };
    const stripper = STRIPPERS[toolName];
    if (stripper) {
      stripper(clone);
    }
    stripped = clone;
  } else if (Array.isArray(result)) {
    const entryStripper = ARRAY_ENTRY_STRIPPERS[toolName];
    if (entryStripper) {
      stripped = (result as readonly unknown[]).map((entry: unknown): unknown => {
        if (isRecord(entry)) {
          const entryClone = { ...entry };
          entryStripper(entryClone);
          return entryClone;
        }
        return entry;
      });
    }
  }

  // Serialize
  const serialized = typeof stripped === "string" ? stripped : safeStringify(stripped);

  // Phase 2: Truncate if necessary
  const maxChars = TOOL_MAX_CHARS[toolName] ?? DEFAULT_MAX_CHARS;
  if (serialized.length <= maxChars) {
    return serialized;
  }

  return truncateResult(toolName, stripped, serialized, maxChars);
}

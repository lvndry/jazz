const DEFAULT_MAX_CHARS = 4000;
const PREVIEW_HEAD_CHARS = 1600;
const PREVIEW_TAIL_CHARS = 800;
const MAX_KEY_PREVIEW = 20;
const MAX_WEB_RESULTS = 5;
const MAX_LS_ITEMS = 20;
const MAX_DIFF_LINES = 40;
const MAX_EDIT_SUMMARY = 5;
const MAX_STDIO_LINES = 20;
const MAX_SNIPPET_CHARS = 200;

interface SummaryOptions {
  readonly maxChars?: number;
}

interface SummarizedToolResult {
  readonly toolName: string;
  readonly truncated: boolean;
  readonly originalType: string;
  readonly originalSizeChars: number;
  readonly summary: string;
  readonly preview: {
    readonly head: string;
    readonly tail: string;
  };
  readonly keys?: readonly string[];
  readonly length?: number;
}

interface ToolSummaryPayload {
  readonly toolName: string;
  readonly summaryType: string;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return JSON.stringify({
      error: "Failed to serialize tool result",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

function getNumber(value: Record<string, unknown>, key: string): number | undefined {
  const entry = value[key];
  return typeof entry === "number" ? entry : undefined;
}

function getBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const entry = value[key];
  return typeof entry === "boolean" ? entry : undefined;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function tailLines(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines) return value;
  return lines.slice(-maxLines).join("\n");
}

function headLines(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines) return value;
  return lines.slice(0, maxLines).join("\n");
}

function summarizeWebSearch(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const payload = result as Record<string, unknown>;
  const resultsValue = payload["results"];
  const results = Array.isArray(resultsValue) ? resultsValue : [];
  if (results.length === 0) return null;

  const topResults = results
    .slice(0, MAX_WEB_RESULTS)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      const title = getString(item, "title") ?? "";
      const url = getString(item, "url") ?? "";
      const snippet = getString(item, "snippet");
      const publishedDate = getString(item, "publishedDate");
      const source = getString(item, "source");

      return {
        title,
        url,
        snippet: snippet ? truncateText(snippet, MAX_SNIPPET_CHARS) : "",
        ...(publishedDate ? { publishedDate } : {}),
        ...(source ? { source } : {}),
      };
    })
    .filter(Boolean);

  const summary: ToolSummaryPayload = {
    toolName,
    summaryType: "web_search",
    summary: "Top web search results (truncated).",
    data: {
      query: getString(payload, "query"),
      provider: getString(payload, "provider"),
      totalResults: getNumber(payload, "totalResults") ?? results.length,
      results: topResults,
    },
  };

  return safeStringify(summary);
}

function summarizeExecuteCommand(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const payload = result as Record<string, unknown>;
  const command = getString(payload, "command");
  const exitCode = getNumber(payload, "exitCode");
  if (!command || typeof exitCode !== "number") return null;

  const stdout = getString(payload, "stdout") ?? "";
  const stderr = getString(payload, "stderr") ?? "";

  const summary: ToolSummaryPayload = {
    toolName,
    summaryType: "execute_command",
    summary: "Shell output truncated for context window.",
    data: {
      command,
      workingDirectory: getString(payload, "workingDirectory"),
      exitCode,
      success: getBoolean(payload, "success") ?? exitCode === 0,
      stdoutTail: tailLines(stdout, MAX_STDIO_LINES),
      stderrTail: tailLines(stderr, MAX_STDIO_LINES),
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
    },
  };

  return safeStringify(summary);
}

function summarizeReadFile(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const payload = result as Record<string, unknown>;
  const content = getString(payload, "content");
  const path = getString(payload, "path");
  if (!content || !path) return null;
  const summary: ToolSummaryPayload = {
    toolName,
    summaryType: "read_file",
    summary: "File content truncated for context window.",
    data: {
      path,
      truncated: getBoolean(payload, "truncated"),
      totalLines: getNumber(payload, "totalLines"),
      returnedLines: getNumber(payload, "returnedLines"),
      range: payload["range"],
      preview: {
        head: content.slice(0, PREVIEW_HEAD_CHARS),
        tail: content.slice(-PREVIEW_TAIL_CHARS),
      },
      bytes: content.length,
    },
  };

  return safeStringify(summary);
}

function summarizeEditFile(toolName: string, result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const payload = result as Record<string, unknown>;
  const path = getString(payload, "path");
  if (!path) return null;

  const editsAppliedValue = payload["editsApplied"];
  const editsApplied = Array.isArray(editsAppliedValue)
    ? editsAppliedValue.slice(0, MAX_EDIT_SUMMARY)
    : [];
  const diff = getString(payload, "diff") ?? "";

  const summary: ToolSummaryPayload = {
    toolName,
    summaryType: "edit_file",
    summary: "File edit summary (diff truncated).",
    data: {
      path,
      editsApplied,
      totalEdits: getNumber(payload, "totalEdits"),
      originalLines: getNumber(payload, "originalLines"),
      newLines: getNumber(payload, "newLines"),
      wasTruncated: getBoolean(payload, "wasTruncated"),
      diffPreview: headLines(diff, MAX_DIFF_LINES),
    },
  };

  return safeStringify(summary);
}

function summarizeLs(toolName: string, result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const items = result
    .slice(0, MAX_LS_ITEMS)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      return {
        name: getString(item, "name") ?? "",
        path: getString(item, "path") ?? "",
        type: getString(item, "type") ?? "",
      };
    })
    .filter(Boolean);

  const summary: ToolSummaryPayload = {
    toolName,
    summaryType: "ls",
    summary: "Directory listing truncated for context window.",
    data: {
      total: result.length,
      items,
    },
  };

  return safeStringify(summary);
}

function formatToolResultByName(toolName: string, result: unknown): string | null {
  switch (toolName) {
    case "web_search":
      return summarizeWebSearch(toolName, result);
    case "execute_command":
    case "execute_execute_command":
      return summarizeExecuteCommand(toolName, result);
    case "read_file":
      return summarizeReadFile(toolName, result);
    case "edit_file":
    case "execute_edit_file":
      return summarizeEditFile(toolName, result);
    case "ls":
      return summarizeLs(toolName, result);
    // Skill content must be passed through in full — truncating instructions
    // defeats the purpose of loading a skill. The context window manager
    // handles overall token budget separately.
    case "load_skill":
    case "load_skill_section":
      return typeof result === "string" ? result : safeStringify(result);
    default:
      return null;
  }
}

function summarizeString(toolName: string, raw: string, maxChars: number): string {
  if (raw.length <= maxChars) {
    return raw;
  }

  const head = raw.slice(0, PREVIEW_HEAD_CHARS);
  const tail = raw.slice(-PREVIEW_TAIL_CHARS);
  const summary: SummarizedToolResult = {
    toolName,
    truncated: true,
    originalType: "string",
    originalSizeChars: raw.length,
    summary: "Tool result truncated. Re-run tool if needed.",
    preview: { head, tail },
  };
  return safeStringify(summary);
}

function summarizeObject(
  toolName: string,
  value: Record<string, unknown>,
  raw: string,
  maxChars: number,
): string {
  if (raw.length <= maxChars) {
    return raw;
  }

  const keys = Object.keys(value).slice(0, MAX_KEY_PREVIEW);
  const head = raw.slice(0, PREVIEW_HEAD_CHARS);
  const tail = raw.slice(-PREVIEW_TAIL_CHARS);
  const summary: SummarizedToolResult = {
    toolName,
    truncated: true,
    originalType: "object",
    originalSizeChars: raw.length,
    summary: "Tool result truncated. Re-run tool if needed.",
    preview: { head, tail },
    keys,
  };
  return safeStringify(summary);
}

function summarizeArray(
  toolName: string,
  value: readonly unknown[],
  raw: string,
  maxChars: number,
): string {
  if (raw.length <= maxChars) {
    return raw;
  }

  const head = raw.slice(0, PREVIEW_HEAD_CHARS);
  const tail = raw.slice(-PREVIEW_TAIL_CHARS);
  const summary: SummarizedToolResult = {
    toolName,
    truncated: true,
    originalType: "array",
    originalSizeChars: raw.length,
    summary: "Tool result truncated. Re-run tool if needed.",
    preview: { head, tail },
    length: value.length,
  };
  return safeStringify(summary);
}

export function formatToolResultForContext(
  toolName: string,
  result: unknown,
  options: SummaryOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const custom = formatToolResultByName(toolName, result);
  if (custom) {
    return custom;
  }

  if (typeof result === "string") {
    return summarizeString(toolName, result, maxChars);
  }

  if (result && typeof result === "object" && Array.isArray(result)) {
    const raw = safeStringify(result);
    return summarizeArray(toolName, result, raw, maxChars);
  }

  if (result && typeof result === "object") {
    const raw = safeStringify(result);
    return summarizeObject(toolName, result as Record<string, unknown>, raw, maxChars);
  }

  const raw = safeStringify(result);
  return raw.length <= maxChars ? raw : summarizeString(toolName, raw, maxChars);
}

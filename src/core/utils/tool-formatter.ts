import chalk from "chalk";
import { safeString } from "./string";

const MAX_RESULT_DISPLAY_LINES = 12;
const MAX_RESULT_DISPLAY_CHARS = 1200;
// Ctrl+O expansion prints the full payload through Ink — cap it so expanding
// a multi-megabyte tool result can't hang the renderer.
const MAX_EXPANDABLE_CHARS = 100_000;

/**
 * User-facing formatting for tool arguments and results.
 *
 * This module targets terminal and log presentation. LLM-context formatting
 * has separate truncation and safety rules in tool-result-formatter.ts.
 */

type FormatStyle = "plain" | "colored";

/**
 * Merge an http_request `query` argument into the displayed URL so searches
 * read as the request actually sent (`…/html/?q=…`), not the bare base URL.
 */
function appendQueryParams(url: string, query: unknown): string {
  if (typeof query !== "object" || query === null || Array.isArray(query)) return url;
  const entries = Object.entries(query as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  if (entries.length === 0) return url;
  const queryString = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(safeString(value))}`)
    .join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${queryString}`;
}

interface FormatOptions {
  style?: FormatStyle;
  /** Executor hints for display (e.g. web_search backend: builtin vs configured provider). */
  metadata?: Record<string, unknown>;
}

/**
 * Format the tool name for display, folding in the backing provider when the
 * executor supplied one — e.g. `web_search(brave)`. Keeps the provider glued
 * to the name so it can never be mistaken for an argument or a concurrency
 * marker in the tool line.
 */
export function formatToolDisplayName(
  toolName: string,
  metadata?: Record<string, unknown>,
): string {
  const provider = safeString(metadata?.["provider"]);
  return provider ? `${toolName}(${provider})` : toolName;
}

const MAX_ARG_VALUE_LENGTH = 120;

function formatArgValue(value: unknown, maxLength: number = MAX_ARG_VALUE_LENGTH): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return "";
    return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json === "{}" || json === "[]") return "";
    return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
  } catch {
    return "";
  }
}

/**
 * Format tool arguments for display
 * Shows relevant parameters for each tool type
 *
 * @param toolName - Registered tool name used to select relevant fields.
 * @param args - Raw tool arguments.
 * @param options - Plain or colored style plus optional executor metadata.
 */
export function formatToolArguments(
  toolName: string,
  args?: Record<string, unknown>,
  options: FormatOptions = { style: "colored" },
): string {
  const style = options.style ?? "colored";
  const usePlain = style === "plain";

  if ((!args || Object.keys(args).length === 0) && toolName !== "view_memory") {
    return "";
  }

  // Helper to format key-value pairs
  function formatKeyValue(key: string, value: string): string {
    if (usePlain) {
      return `${key}: ${value}`;
    }
    return ` ${chalk.dim(`${key}:`)} ${chalk.cyan(value)}`;
  }

  // Helper to format parts list
  function formatParts(parts: string[]): string {
    if (parts.length === 0) return "";
    if (usePlain) {
      return `{ ${parts.join(", ")} }`;
    }
    return parts.join("");
  }

  const toolArgs = args ?? {};

  // Format arguments based on tool type
  switch (toolName) {
    case "view_memory": {
      const path = safeString(toolArgs["path"]);
      const displayPath = path.trim().length === 0 || path === "/" ? "/" : path;
      const parts: string[] = [formatKeyValue("path", displayPath)];
      const range = toolArgs["view_range"];
      if (Array.isArray(range) && range.length === 2) {
        const start = formatArgValue(range[0]);
        const end = formatArgValue(range[1]);
        if (start.length > 0 && end.length > 0) {
          const span = `${start}–${end}`;
          parts.push(usePlain ? `lines: ${span}` : ` ${chalk.dim(`lines: ${span}`)}`);
        }
      }
      return formatParts(parts);
    }
    case "read_file": {
      const parts: string[] = [];
      const path = safeString(toolArgs["path"] || toolArgs["filePath"]);
      if (path) {
        if (usePlain) {
          parts.push(`file: ${path}`);
        } else {
          parts.push(formatKeyValue("file", path));
        }
      }
      const startLine = toolArgs["startLine"];
      const endLine = toolArgs["endLine"];
      if (typeof startLine === "number" || typeof endLine === "number") {
        const start = typeof startLine === "number" ? startLine : undefined;
        const end = typeof endLine === "number" ? endLine : undefined;
        if (start && end) {
          parts.push(
            usePlain ? `lines: ${start}-${end}` : ` ${chalk.dim(`lines: ${start}-${end}`)}`,
          );
        } else if (start) {
          parts.push(usePlain ? `from line: ${start}` : ` ${chalk.dim(`from line: ${start}`)}`);
        } else if (end) {
          parts.push(usePlain ? `to line: ${end}` : ` ${chalk.dim(`to line: ${end}`)}`);
        }
      }
      return formatParts(parts);
    }
    case "grep": {
      const parts: string[] = [];
      const pattern = safeString(toolArgs["pattern"]);
      if (pattern) {
        if (usePlain) {
          parts.push(`pattern: ${pattern}`);
        } else {
          parts.push(formatKeyValue("pattern", pattern));
        }
      }
      const path = safeString(toolArgs["path"]);
      if (path) {
        if (usePlain) {
          parts.push(`in: ${path}`);
        } else {
          parts.push(` ${chalk.dim(`in: ${path}`)}`);
        }
      }
      const flags: string[] = [];
      if (toolArgs["recursive"] === true) flags.push("--recursive");
      if (toolArgs["ignoreCase"] === true) flags.push("--ignore-case");
      const rawPattern = toolArgs["pattern"];
      if (
        toolArgs["regex"] === true ||
        (typeof rawPattern === "string" && rawPattern.startsWith("re:"))
      ) {
        flags.push("--regex");
      }
      if (toolArgs["filePattern"]) {
        const filePattern = safeString(toolArgs["filePattern"]);
        if (filePattern) flags.push(`--include=${filePattern}`);
      }
      if (toolArgs["exclude"]) {
        const exclude = safeString(toolArgs["exclude"]);
        if (exclude) flags.push(`--exclude=${exclude}`);
      }
      if (toolArgs["excludeDir"]) {
        const excludeDir = safeString(toolArgs["excludeDir"]);
        if (excludeDir) flags.push(`--exclude-dir=${excludeDir}`);
      }
      if (flags.length > 0) {
        parts.push(
          usePlain ? `flags: ${flags.join(" ")}` : ` ${chalk.dim(`flags: ${flags.join(" ")}`)}`,
        );
      }
      if (toolArgs["maxResults"]) {
        const maxResults = safeString(toolArgs["maxResults"]);
        if (maxResults) {
          parts.push(usePlain ? `max: ${maxResults}` : ` ${chalk.dim(`max: ${maxResults}`)}`);
        }
      }

      if (toolArgs["contextLines"]) {
        const contextLines = safeString(toolArgs["contextLines"]);
        if (contextLines) {
          parts.push(
            usePlain ? `context: ${contextLines}` : ` ${chalk.dim(`context: ${contextLines}`)}`,
          );
        }
      }
      return formatParts(parts);
    }
    case "write_file":
    case "execute_write_file":
    case "edit_file":
    case "execute_edit_file": {
      const path = safeString(toolArgs["path"] || toolArgs["filePath"]);
      if (!path) return "";
      return usePlain ? `{ file: ${path} }` : formatKeyValue("file", path);
    }
    case "cd": {
      const to = safeString(toolArgs["path"] || toolArgs["directory"]);
      if (!to) return "";
      return usePlain ? `{ path: ${to} }` : ` ${chalk.dim("→")} ${chalk.cyan(to)}`;
    }
    case "ls": {
      const parts: string[] = [];
      const dir = safeString(toolArgs["path"]);
      if (dir) {
        if (usePlain) {
          parts.push(`dir: ${dir}`);
        } else {
          parts.push(formatKeyValue("dir", dir));
        }
      }
      if (toolArgs["all"] === true) parts.push(usePlain ? "--all" : ` ${chalk.dim("--all")}`);
      if (toolArgs["long"] === true) parts.push(usePlain ? "--long" : ` ${chalk.dim("--long")}`);
      return formatParts(parts);
    }
    case "find": {
      const parts: string[] = [];
      const searchPath = safeString(toolArgs["path"]);
      if (searchPath) {
        if (usePlain) {
          parts.push(`path: ${searchPath}`);
        } else {
          parts.push(formatKeyValue("path", searchPath));
        }
      }
      const name = safeString(toolArgs["name"]);
      if (name) {
        if (usePlain) {
          parts.push(`name: ${name}`);
        } else {
          parts.push(formatKeyValue("name", name));
        }
      }
      const type = safeString(toolArgs["type"]);
      if (type) {
        if (usePlain) {
          parts.push(`type: ${type}`);
        } else {
          parts.push(formatKeyValue("type", type));
        }
      }
      return formatParts(parts);
    }
    case "execute_command":
    case "execute_execute_command": {
      const command = safeString(toolArgs["command"]);
      if (!command) return "";
      return usePlain
        ? `{ command: "${command}" }`
        : ` ${chalk.dim("command:")} ${chalk.cyan(command)}`;
    }
    case "http_request": {
      const parts: string[] = [];
      const method = safeString(toolArgs["method"] || "GET");
      if (usePlain) {
        parts.push(`method: ${method}`);
      } else {
        parts.push(` ${chalk.dim(`${method}:`)}`);
      }
      const url = safeString(toolArgs["url"]);
      if (url) {
        const resolvedUrl = appendQueryParams(url, toolArgs["query"]);
        if (usePlain) {
          parts.push(`url: ${resolvedUrl}`);
        } else {
          parts.push(` ${chalk.cyan(resolvedUrl)}`);
        }
      }
      return formatParts(parts);
    }
    case "web_search": {
      // Check common query argument names across providers. The provider
      // itself renders inside the tool name via formatToolDisplayName.
      const query = safeString(toolArgs["query"] || toolArgs["search_query"] || toolArgs["q"]);
      if (!query) return "";
      return usePlain ? `{ query: "${query}" }` : formatKeyValue("query", query);
    }
    case "mkdir": {
      const dirPath = safeString(toolArgs["path"]);
      if (!dirPath) return "";
      return usePlain ? `{ path: ${dirPath} }` : formatKeyValue("path", dirPath);
    }
    case "manage_todos": {
      const todos = toolArgs["todos"];
      if (!Array.isArray(todos)) return "";
      const total = todos.length;
      let completed = 0;
      let inProgress = 0;
      for (const todo of todos) {
        if (typeof todo !== "object" || todo === null || Array.isArray(todo)) continue;
        const status = (todo as Record<string, unknown>)["status"];
        if (status === "completed") completed += 1;
        if (status === "in_progress") inProgress += 1;
      }
      const value = `${total} items (${completed} done, ${inProgress} in progress)`;
      return usePlain ? `{ todos: ${value} }` : formatKeyValue("todos", value);
    }
    default: {
      const keys = Object.keys(toolArgs).slice(0, usePlain ? 3 : 2);
      const parts: string[] = [];
      for (const key of keys) {
        const valueStr = formatArgValue(toolArgs[key]);
        if (valueStr.length === 0) continue;
        parts.push(
          usePlain ? `${key}: ${valueStr}` : `${chalk.dim(`${key}:`)} ${chalk.cyan(valueStr)}`,
        );
      }
      if (parts.length === 0) return "";
      return usePlain ? `{ ${parts.join(", ")} }` : ` ${parts.join(", ")}`;
    }
  }
}

/**
 * Arguments for a live tool row or a settled receipt: the same fields
 * `formatToolArguments` would show, without the wrapping braces plain style
 * adds around a list.
 */
export function compactToolArguments(toolName: string, args?: Record<string, unknown>): string {
  const formatted = formatToolArguments(toolName, args, { style: "plain" }).trim();
  if (formatted.startsWith("{") && formatted.endsWith("}")) {
    return formatted.slice(1, -1).trim();
  }
  return formatted;
}

/**
 * Summarize load_skill tool payload when the stream passes JSON.stringify(innerResult)
 * (a string body), not the full { success, result } envelope.
 */
function formatLoadSkillStringBody(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  const loaded = /^Loaded skill:\s*(.+)$/.exec(firstLine);
  if (loaded) {
    return ` ${chalk.dim(`(loaded · ${loaded[1]})`)}`;
  }
  return ` ${chalk.dim("(loaded)")}`;
}

/** Same as formatLoadSkillStringBody for load_skill_section payloads. */
function formatLoadSkillSectionStringBody(body: string): string {
  const section = /^Loaded section '([^']*)' from skill '([^']*)':/.exec(body);
  if (section) {
    return ` ${chalk.dim(`(section · ${section[2]}/${section[1]})`)}`;
  }
  return ` ${chalk.dim("(loaded)")}`;
}

/**
 * If a tool result is large enough that the displayed summary truncates it,
 * return the full (pretty-printed when JSON) text for Ctrl+O expansion.
 * Returns null when the result fits on screen untruncated.
 *
 * The truncation DECISION uses the raw text — the same signal that drives
 * the on-screen `ctrl+o to expand` hint — so hint and payload can't desync
 * (a pretty-printed form that expands past the caps must not clobber the
 * stored expandable output of a previous, visibly truncated tool).
 */
export function expandableToolResultPayload(result: string): string | null {
  const normalized = result.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;
  const withinCaps =
    normalized.split("\n").length <= MAX_RESULT_DISPLAY_LINES &&
    normalized.length <= MAX_RESULT_DISPLAY_CHARS;
  if (withinCaps) return null;
  let pretty = normalized;
  try {
    pretty = JSON.stringify(JSON.parse(normalized), null, 2);
  } catch {
    // Not JSON — expand the raw text as-is.
  }
  if (pretty.length > MAX_EXPANDABLE_CHARS) {
    return pretty.slice(0, MAX_EXPANDABLE_CHARS).trimEnd() + "\n… output capped at 100k characters";
  }
  return pretty;
}

/**
 * Format tool result for display
 * Shows relevant summary information for each tool type
 */
export function formatToolResult(toolName: string, result: string): string {
  function truncateDisplayText(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return "";

    const lines = normalized.split("\n");
    const visibleLines = lines.slice(0, MAX_RESULT_DISPLAY_LINES);
    const omittedLines = lines.length - visibleLines.length;

    let output = visibleLines.join("\n");
    let charTruncated = false;
    if (output.length > MAX_RESULT_DISPLAY_CHARS) {
      output = output.slice(0, MAX_RESULT_DISPLAY_CHARS).trimEnd() + "…";
      charTruncated = true;
    }
    if (omittedLines > 0) {
      output += `\n… ${omittedLines} more line${omittedLines === 1 ? "" : "s"} · ctrl+o to expand`;
    } else if (charTruncated) {
      output += `\n… output capped · ctrl+o to expand`;
    }
    return output;
  }

  function formatTodoList(parsedResult: Record<string, unknown>): string {
    const todos = Array.isArray(parsedResult["todos"]) ? parsedResult["todos"] : [];
    if (todos.length === 0) {
      return safeString(parsedResult["message"]);
    }

    const lines = todos.flatMap((todo) => {
      if (typeof todo !== "object" || todo === null || Array.isArray(todo)) return [];
      const item = todo as Record<string, unknown>;
      const content = safeString(item["content"]);
      if (!content) return [];

      const status = safeString(item["status"]) || "unknown";
      const priority = safeString(item["priority"]);
      const glyph =
        status === "completed"
          ? "✓"
          : status === "in_progress"
            ? "◐"
            : status === "cancelled"
              ? "✗"
              : "○";
      return [priority ? `${glyph} ${content} (${priority})` : `${glyph} ${content}`];
    });

    return lines.join("\n");
  }

  function formatContextInfo(parsedResult: Record<string, unknown>): string {
    const estimatedTokensUsed = safeString(parsedResult["estimatedTokensUsed"]);
    const maxTokens = safeString(parsedResult["maxTokens"]);
    const remainingTokens = safeString(parsedResult["remainingTokens"]);
    const percentUsed = safeString(parsedResult["percentUsed"]);
    const recommendation = safeString(parsedResult["recommendation"]);

    const lines = [
      estimatedTokensUsed ? `estimatedTokensUsed: ${estimatedTokensUsed}` : "",
      maxTokens ? `maxTokens: ${maxTokens}` : "",
      remainingTokens ? `remainingTokens: ${remainingTokens}` : "",
      percentUsed ? `percentUsed: ${percentUsed}%` : "",
      recommendation ? `recommendation: ${recommendation}` : "",
    ].filter((line) => line.length > 0);

    return lines.join("\n");
  }

  function formatReadFileResult(parsedResult: Record<string, unknown>): string {
    const path = safeString(parsedResult["path"]);
    const content = safeString(parsedResult["content"]);
    const truncated = parsedResult["truncated"] === true;
    const lines: string[] = [];

    if (path) lines.push(path);
    if (content) {
      if (lines.length > 0) lines.push("");
      lines.push(content);
    }
    if (truncated) {
      lines.push("");
      lines.push("[truncated]");
    }

    return lines.join("\n");
  }

  function formatCommandResult(parsedResult: Record<string, unknown>): string {
    const stdout = safeString(parsedResult["stdout"]);
    const stderr = safeString(parsedResult["stderr"]);
    const exitCode = safeString(parsedResult["exitCode"]);
    const failed = exitCode !== "" && exitCode !== "0";

    if (!stdout && !stderr) {
      return failed ? `failed (exit code ${exitCode}), no output` : "no output";
    }

    const lines: string[] = [];
    if (stdout) lines.push(stdout);
    if (stderr) {
      if (stdout) lines.push("");
      lines.push("stderr:");
      lines.push(stderr);
    }
    if (failed) {
      lines.push("");
      lines.push(`failed (exit code ${exitCode})`);
    }

    return lines.join("\n");
  }

  function formatGenericObject(parsedResult: Record<string, unknown>): string {
    const formatted = parsedResult["formatted"];
    if (typeof formatted === "string" && formatted.trim().length > 0) {
      return formatted;
    }
    const content = parsedResult["content"];
    if (typeof content === "string" && content.trim().length > 0) {
      return content;
    }
    const message = parsedResult["message"];
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
    const scalars: string[] = [];
    for (const [key, value] of Object.entries(parsedResult)) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        continue;
      }
      const text = typeof value === "string" ? value.trim() : String(value);
      if (text.length === 0) continue;
      scalars.push(`${key}: ${text}`);
      if (scalars.length >= 3) break;
    }
    if (scalars.length > 0) return scalars.join(" · ");
    return JSON.stringify(parsedResult, null, 2);
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (toolName === "load_skill" && typeof parsed === "string") {
      return formatLoadSkillStringBody(parsed);
    }
    if (toolName === "load_skill_section" && typeof parsed === "string") {
      return formatLoadSkillSectionStringBody(parsed);
    }
    if (typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") {
      return truncateDisplayText(String(parsed));
    }
    if (parsed === null) {
      return "null";
    }
    if (Array.isArray(parsed)) {
      const parsedArray: readonly unknown[] = parsed;
      return truncateDisplayText(JSON.stringify(parsedArray, null, 2));
    }

    const parsedResult = parsed as Record<string, unknown>;

    switch (toolName) {
      case "list_todos":
        return truncateDisplayText(formatTodoList(parsedResult));
      case "manage_todos":
        return truncateDisplayText(
          formatTodoList(parsedResult) || safeString(parsedResult["message"]),
        );
      case "context_info":
        return truncateDisplayText(formatContextInfo(parsedResult));
      case "load_skill":
      case "load_skill_section": {
        if (parsedResult["success"] === true) {
          return ` ${chalk.dim("(loaded)")}`;
        }
        return ` ${chalk.red(`(error: ${safeString(parsedResult["error"] || parsedResult["result"])})`)}`;
      }
      case "spawn_subagent": {
        if (parsedResult["success"] === true) {
          return ` ${chalk.dim("(sub-agent completed)")}`;
        }
        return ` ${chalk.red(`(error: ${safeString(parsedResult["error"] || parsedResult["result"])})`)}`;
      }
      case "grep": {
        const matches = parsedResult["matches"] || parsedResult;
        const count = Array.isArray(matches) ? matches.length : 0;
        return count > 0 ? ` ${chalk.dim(`(${count} match${count !== 1 ? "es" : ""})`)}` : "";
      }
      case "ls": {
        const items = parsedResult["items"] || parsedResult["files"] || parsedResult;
        const count = Array.isArray(items) ? items.length : 0;
        return count > 0 ? ` ${chalk.dim(`(${count} item${count !== 1 ? "s" : ""})`)}` : "";
      }
      case "read_file": {
        return truncateDisplayText(formatReadFileResult(parsedResult));
      }
      case "cd": {
        const newPath = safeString(parsedResult["path"] || parsedResult["currentDirectory"]);
        return newPath ? ` ${chalk.dim("→")} ${chalk.cyan(newPath)}` : "";
      }
      case "execute_command":
      case "execute_execute_command": {
        return truncateDisplayText(formatCommandResult(parsedResult));
      }
      case "http_request": {
        const status = parsedResult["statusCode"];
        if (status !== undefined && status !== null) {
          const statusStr = safeString(status);
          return statusStr ? ` ${chalk.dim(`(${statusStr})`)}` : "";
        }
        return "";
      }
      case "edit_file":
      case "execute_edit_file":
      case "write_file":
      case "execute_write_file": {
        // Check for diff in the result
        const diff = parsedResult["diff"];
        if (typeof diff === "string" && diff.length > 0) {
          return `\n${diff}`;
        }
        return "";
      }
      case "read_pdf": {
        const pageCount = parsedResult["pageCount"];
        const pagesExtracted = parsedResult["pagesExtracted"];
        const truncated = parsedResult["truncated"];
        const path = parsedResult["path"];
        const tables = parsedResult["tables"];
        const totalLines = parsedResult["totalLines"];
        const summaryParts: string[] = [];
        if (path) summaryParts.push(`file: ${safeString(path)}`);
        if (Array.isArray(pagesExtracted) && pagesExtracted.length > 0) {
          summaryParts.push(`pages: ${pagesExtracted.join(", ")}`);
        }
        if (typeof pageCount === "number") {
          summaryParts.push(`total: ${pageCount}`);
        }
        if (typeof totalLines === "number") {
          summaryParts.push(`lines: ${totalLines}`);
        }
        if (Array.isArray(tables)) {
          summaryParts.push(`tables: ${tables.length}`);
        }
        if (truncated) summaryParts.push(chalk.yellow("truncated"));
        return summaryParts.length > 0
          ? ` ${chalk.dim("(")}${summaryParts.join(", ")}${chalk.dim(")")}`
          : "";
      }
      default:
        return truncateDisplayText(formatGenericObject(parsedResult));
    }
  } catch {
    return truncateDisplayText(result);
  }
}

const SNIPPET_MAX_CHARS = 88;
const SNIPPET_MAX_LINES = 2;

function isStructuralJsonLine(line: string): boolean {
  return line === "{" || line === "}" || line === "[" || line === "]" || line === "{},";
}

/**
 * One or two content lines from a formatted tool result, for a receipt row.
 * Skips brace-only JSON so a pretty-printed object cannot collapse to `{`.
 */
export function toolResultSnippet(text: string): string {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || isStructuralJsonLine(trimmed)) continue;
    lines.push(trimmed.replace(/\s+/g, " "));
    if (lines.length >= SNIPPET_MAX_LINES) break;
  }
  const joined = lines.join(" · ");
  if (joined.length <= SNIPPET_MAX_CHARS) return joined;
  return `${joined.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

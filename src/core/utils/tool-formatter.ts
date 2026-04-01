import chalk from "chalk";
import { safeString } from "./string";

const MAX_RESULT_DISPLAY_LINES = 12;
const MAX_RESULT_DISPLAY_CHARS = 1200;

/**
 * Utility functions for formatting tool arguments and results
 * Used by both streaming and non-streaming modes
 */

type FormatStyle = "plain" | "colored";

interface FormatOptions {
  style?: FormatStyle;
}

/**
 * Format tool arguments for display
 * Shows relevant parameters for each tool type
 * @param style - "plain" for logger (no colors, { } format), "colored" for console output (chalk colors)
 */
export function formatToolArguments(
  toolName: string,
  args?: Record<string, unknown>,
  options: FormatOptions = { style: "colored" },
): string {
  if (!args || Object.keys(args).length === 0) {
    return "";
  }

  const style = options.style ?? "colored";
  const usePlain = style === "plain";

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

  // Format arguments based on tool type
  switch (toolName) {
    case "read_file": {
      const parts: string[] = [];
      const path = safeString(args["path"] || args["filePath"]);
      if (path) {
        if (usePlain) {
          parts.push(`file: ${path}`);
        } else {
          parts.push(formatKeyValue("file", path));
        }
      }
      const startLine = args["startLine"];
      const endLine = args["endLine"];
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
      const pattern = safeString(args["pattern"]);
      if (pattern) {
        if (usePlain) {
          parts.push(`pattern: ${pattern}`);
        } else {
          parts.push(formatKeyValue("pattern", pattern));
        }
      }
      const path = safeString(args["path"]);
      if (path) {
        if (usePlain) {
          parts.push(`in: ${path}`);
        } else {
          parts.push(` ${chalk.dim(`in: ${path}`)}`);
        }
      }
      const flags: string[] = [];
      if (args["recursive"] === true) flags.push("--recursive");
      if (args["ignoreCase"] === true) flags.push("--ignore-case");
      const rawPattern = args["pattern"];
      if (
        args["regex"] === true ||
        (typeof rawPattern === "string" && rawPattern.startsWith("re:"))
      ) {
        flags.push("--regex");
      }
      if (args["filePattern"]) {
        const filePattern = safeString(args["filePattern"]);
        if (filePattern) flags.push(`--include=${filePattern}`);
      }
      if (args["exclude"]) {
        const exclude = safeString(args["exclude"]);
        if (exclude) flags.push(`--exclude=${exclude}`);
      }
      if (args["excludeDir"]) {
        const excludeDir = safeString(args["excludeDir"]);
        if (excludeDir) flags.push(`--exclude-dir=${excludeDir}`);
      }
      if (flags.length > 0) {
        parts.push(
          usePlain ? `flags: ${flags.join(" ")}` : ` ${chalk.dim(`flags: ${flags.join(" ")}`)}`,
        );
      }
      if (args["maxResults"]) {
        const maxResults = safeString(args["maxResults"]);
        if (maxResults) {
          parts.push(usePlain ? `max: ${maxResults}` : ` ${chalk.dim(`max: ${maxResults}`)}`);
        }
      }

      if (args["contextLines"]) {
        const contextLines = safeString(args["contextLines"]);
        if (contextLines) {
          parts.push(
            usePlain ? `context: ${contextLines}` : ` ${chalk.dim(`context: ${contextLines}`)}`,
          );
        }
      }
      return formatParts(parts);
    }
    case "write_file":
    case "execute_write_file": {
      const path = safeString(args["path"] || args["filePath"]);
      if (!path) return "";
      return usePlain ? `{ file: ${path} }` : formatKeyValue("file", path);
    }
    case "execute_edit_file": {
      const path = safeString(args["path"] || args["filePath"]);
      if (!path) return "";
      return usePlain ? `{ file: ${path} }` : formatKeyValue("file", path);
    }
    case "cd": {
      const to = safeString(args["path"] || args["directory"]);
      if (!to) return "";
      return usePlain ? `{ path: ${to} }` : ` ${chalk.dim("→")} ${chalk.cyan(to)}`;
    }
    case "ls": {
      const parts: string[] = [];
      const dir = safeString(args["path"]);
      if (dir) {
        if (usePlain) {
          parts.push(`dir: ${dir}`);
        } else {
          parts.push(formatKeyValue("dir", dir));
        }
      }
      if (args["all"] === true) parts.push(usePlain ? "--all" : ` ${chalk.dim("--all")}`);
      if (args["long"] === true) parts.push(usePlain ? "--long" : ` ${chalk.dim("--long")}`);
      return formatParts(parts);
    }
    case "find": {
      const parts: string[] = [];
      const searchPath = safeString(args["path"]);
      if (searchPath) {
        if (usePlain) {
          parts.push(`path: ${searchPath}`);
        } else {
          parts.push(formatKeyValue("path", searchPath));
        }
      }
      const name = safeString(args["name"]);
      if (name) {
        if (usePlain) {
          parts.push(`name: ${name}`);
        } else {
          parts.push(formatKeyValue("name", name));
        }
      }
      const type = safeString(args["type"]);
      if (type) {
        if (usePlain) {
          parts.push(`type: ${type}`);
        } else {
          parts.push(formatKeyValue("type", type));
        }
      }
      return formatParts(parts);
    }
    case "git_status":
      return "";
    case "git_log": {
      const limit = args["limit"];
      const limitStr = safeString(limit);
      if (!limitStr) return "";
      return usePlain ? `{ limit: ${limitStr} }` : formatKeyValue("limit", limitStr);
    }
    case "git_diff": {
      const parts: string[] = [];
      if (args["nameOnly"] === true) {
        parts.push(usePlain ? "nameOnly: true" : formatKeyValue("nameOnly", "true"));
      }
      const commit = safeString(args["commit"]);
      if (commit) {
        parts.push(usePlain ? `commit: ${commit}` : formatKeyValue("commit", commit));
      }
      const paths = args["paths"];
      if (Array.isArray(paths) && paths.length > 0) {
        const pathsStr = paths.map((p) => (typeof p === "string" ? p : String(p))).join(", ");
        const display =
          paths.length <= 3
            ? pathsStr
            : `${paths.slice(0, 3).join(", ")} +${paths.length - 3} more`;
        parts.push(usePlain ? `paths: [${display}]` : formatKeyValue("paths", `[${display}]`));
      }
      const maxLines = args["maxLines"];
      if (typeof maxLines === "number") {
        parts.push(
          usePlain ? `maxLines: ${maxLines}` : formatKeyValue("maxLines", String(maxLines)),
        );
      }
      return formatParts(parts);
    }
    case "git_commit": {
      const message = safeString(args["message"]);
      if (!message) return "";
      return usePlain
        ? `{ message: "${message}" }`
        : ` ${chalk.dim("message:")} ${chalk.cyan(message)}`;
    }
    case "git_push": {
      const branch = safeString(args["branch"]);
      if (!branch) return "";
      return usePlain ? `{ branch: ${branch} }` : formatKeyValue("branch", branch);
    }
    case "git_pull":
      return "";
    case "git_checkout": {
      const branchName = safeString(args["branch"]);
      if (!branchName) return "";
      return usePlain ? `{ branch: ${branchName} }` : formatKeyValue("branch", branchName);
    }
    case "execute_command":
    case "execute_execute_command": {
      const command = safeString(args["command"]);
      if (!command) return "";
      return usePlain
        ? `{ command: "${command}" }`
        : ` ${chalk.dim("command:")} ${chalk.cyan(command)}`;
    }
    case "http_request": {
      const parts: string[] = [];
      const method = safeString(args["method"] || "GET");
      if (usePlain) {
        parts.push(`method: ${method}`);
      } else {
        parts.push(` ${chalk.dim(`${method}:`)}`);
      }
      const url = safeString(args["url"]);
      if (url) {
        if (usePlain) {
          parts.push(`url: ${url}`);
        } else {
          parts.push(` ${chalk.cyan(url)}`);
        }
      }
      return formatParts(parts);
    }
    case "web_search": {
      // Check common query argument names across providers
      const query = safeString(args["query"] || args["search_query"] || args["q"]);
      if (!query) return "";
      return usePlain ? `{ query: "${query}" }` : formatKeyValue("query", query);
    }
    case "mkdir": {
      const dirPath = safeString(args["path"]);
      if (!dirPath) return "";
      return usePlain ? `{ path: ${dirPath} }` : formatKeyValue("path", dirPath);
    }
    case "manage_todos": {
      const todos = args["todos"];
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
      // For unknown tools, show first few arguments (truncate long values)
      const MAX_VALUE_LENGTH = 120;
      const keys = Object.keys(args).slice(0, usePlain ? 3 : 2);
      if (keys.length === 0) return "";
      const parts = keys.map((key) => {
        let valueStr = safeString(args[key]);
        if (valueStr.length > MAX_VALUE_LENGTH) {
          valueStr = valueStr.slice(0, MAX_VALUE_LENGTH) + "…";
        }
        if (usePlain) {
          return `${key}: ${valueStr}`;
        }
        return `${chalk.dim(`${key}:`)} ${chalk.cyan(valueStr)}`;
      });
      return usePlain ? `{ ${parts.join(", ")} }` : ` ${parts.join(", ")}`;
    }
  }
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
    if (output.length > MAX_RESULT_DISPLAY_CHARS) {
      output = output.slice(0, MAX_RESULT_DISPLAY_CHARS).trimEnd() + "…";
    }
    if (omittedLines > 0) {
      output += `\n… ${omittedLines} more line${omittedLines === 1 ? "" : "s"}`;
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

    if (!stdout && !stderr) {
      return exitCode ? `exitCode: ${exitCode}` : "";
    }

    const lines: string[] = [];
    if (stdout) lines.push(stdout);
    if (stderr) {
      if (stdout) lines.push("");
      lines.push("stderr:");
      lines.push(stderr);
    }
    if (exitCode && exitCode !== "0") {
      lines.push("");
      lines.push(`exitCode: ${exitCode}`);
    }

    return lines.join("\n");
  }

  function formatGenericObject(parsedResult: Record<string, unknown>): string {
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
      case "git_status": {
        const branch = safeString(parsedResult["branch"]);
        const modified = Array.isArray(parsedResult["modified"])
          ? parsedResult["modified"].length
          : 0;
        const staged = Array.isArray(parsedResult["staged"]) ? parsedResult["staged"].length : 0;
        const parts: string[] = [];
        if (branch) parts.push(chalk.cyan(branch));
        if (modified > 0) parts.push(chalk.yellow(`${modified} modified`));
        if (staged > 0) parts.push(chalk.green(`${staged} staged`));
        return parts.length > 0
          ? ` ${chalk.dim("(")}${parts.join(chalk.dim(", "))}${chalk.dim(")")}`
          : "";
      }
      case "git_log": {
        const commits = parsedResult["commits"] || parsedResult;
        const count = Array.isArray(commits) ? commits.length : 0;
        return count > 0 ? ` ${chalk.dim(`(${count} commit${count !== 1 ? "s" : ""})`)}` : "";
      }
      case "git_diff": {
        const parts: string[] = [];
        const paths = parsedResult["paths"];
        const nameOnly = parsedResult["nameOnly"] === true;
        if (Array.isArray(paths) && paths.length > 0) {
          parts.push(chalk.cyan(`${paths.length} file${paths.length !== 1 ? "s" : ""}`));
          if (nameOnly) {
            parts.push(chalk.dim("(names only)"));
          }
        }
        const truncated = parsedResult["truncated"];
        if (truncated === true) {
          parts.push(chalk.yellow("truncated"));
        }
        const hasChanges = parsedResult["hasChanges"];
        if (hasChanges === false && !nameOnly) {
          parts.push(chalk.dim("no diff"));
        }
        return parts.length > 0
          ? ` ${chalk.dim("(")}${parts.join(chalk.dim(", "))}${chalk.dim(")")}`
          : "";
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
      case "execute_edit_file":
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

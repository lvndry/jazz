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

  function formatTodoList(obj: Record<string, unknown>): string {
    const todos = Array.isArray(obj["todos"]) ? obj["todos"] : [];
    if (todos.length === 0) {
      return safeString(obj["message"]);
    }

    const lines = todos.flatMap((todo) => {
      if (typeof todo !== "object" || todo === null || Array.isArray(todo)) return [];
      const item = todo as Record<string, unknown>;
      const content = safeString(item["content"]);
      if (!content) return [];

      const status = safeString(item["status"]) || "unknown";
      const priority = safeString(item["priority"]);
      return [priority ? `[${status}] ${content} (${priority})` : `[${status}] ${content}`];
    });

    return lines.join("\n");
  }

  function formatGitStatus(obj: Record<string, unknown>): string {
    const lines: string[] = [];
    const branch = safeString(obj["branch"]);
    if (branch) {
      lines.push(`branch: ${branch}`);
    }

    const summary = Array.isArray(obj["summary"]) ? obj["summary"] : [];
    for (const entry of summary) {
      const text = safeString(entry);
      if (text) lines.push(text);
    }

    return lines.join("\n");
  }

  function formatContextInfo(obj: Record<string, unknown>): string {
    const estimatedTokensUsed = safeString(obj["estimatedTokensUsed"]);
    const maxTokens = safeString(obj["maxTokens"]);
    const remainingTokens = safeString(obj["remainingTokens"]);
    const percentUsed = safeString(obj["percentUsed"]);
    const recommendation = safeString(obj["recommendation"]);

    const lines = [
      estimatedTokensUsed ? `estimatedTokensUsed: ${estimatedTokensUsed}` : "",
      maxTokens ? `maxTokens: ${maxTokens}` : "",
      remainingTokens ? `remainingTokens: ${remainingTokens}` : "",
      percentUsed ? `percentUsed: ${percentUsed}%` : "",
      recommendation ? `recommendation: ${recommendation}` : "",
    ].filter((line) => line.length > 0);

    return lines.join("\n");
  }

  function formatReadFileResult(obj: Record<string, unknown>): string {
    const path = safeString(obj["path"]);
    const content = safeString(obj["content"]);
    const truncated = obj["truncated"] === true;
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

  function formatCommandResult(obj: Record<string, unknown>): string {
    const stdout = safeString(obj["stdout"]);
    const stderr = safeString(obj["stderr"]);
    const exitCode = safeString(obj["exitCode"]);

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

  function formatGenericObject(obj: Record<string, unknown>): string {
    return JSON.stringify(obj, null, 2);
  }

  try {
    const parsed: unknown = JSON.parse(result);
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

    const obj = parsed as Record<string, unknown>;

    switch (toolName) {
      case "list_todos":
        return truncateDisplayText(formatTodoList(obj));
      case "manage_todos":
        return truncateDisplayText(formatTodoList(obj) || safeString(obj["message"]));
      case "context_info":
        return truncateDisplayText(formatContextInfo(obj));
      case "git_status":
        return truncateDisplayText(formatGitStatus(obj));
      case "read_file": {
        return truncateDisplayText(formatReadFileResult(obj));
      }
      case "cd": {
        const newPath = safeString(obj["path"] || obj["currentDirectory"]);
        return newPath ? ` ${chalk.dim("→")} ${chalk.cyan(newPath)}` : "";
      }
      case "execute_command":
      case "execute_execute_command": {
        return truncateDisplayText(formatCommandResult(obj));
      }
      case "execute_edit_file":
      case "execute_write_file": {
        // Check for diff in the result
        const diff = obj["diff"];
        if (typeof diff === "string" && diff.length > 0) {
          return `\n${diff}`;
        }
        return "";
      }
      default:
        return truncateDisplayText(formatGenericObject(obj));
    }
  } catch {
    return truncateDisplayText(result);
  }
}

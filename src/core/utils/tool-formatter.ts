import chalk from "chalk";
import { safeString } from "./string";

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
    case "write_file": {
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
    case "git_diff":
      return "";
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
    default: {
      // For unknown tools, show first few arguments
      const keys = Object.keys(args).slice(0, usePlain ? 3 : 2);
      if (keys.length === 0) return "";
      const parts = keys.map((key) => {
        const valueStr = safeString(args[key]);
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
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "";
    }

    const obj = parsed as Record<string, unknown>;

    switch (toolName) {
      case "read_file": {
        const content = obj["content"];
        if (typeof content !== "string") return "";
        const lines = content.split("\n").length;
        return ` ${chalk.dim(`(${lines} line${lines !== 1 ? "s" : ""})`)}`;
      }
      case "cd": {
        const newPath = safeString(obj["path"] || obj["currentDirectory"]);
        return newPath ? ` ${chalk.dim("→")} ${chalk.cyan(newPath)}` : "";
      }
      case "git_status": {
        const branch = safeString(obj["branch"]);
        const modified = Array.isArray(obj["modified"]) ? obj["modified"].length : 0;
        const staged = Array.isArray(obj["staged"]) ? obj["staged"].length : 0;
        const parts: string[] = [];
        if (branch) parts.push(chalk.cyan(branch));
        if (modified > 0) parts.push(chalk.yellow(`${modified} modified`));
        if (staged > 0) parts.push(chalk.green(`${staged} staged`));
        return parts.length > 0
          ? ` ${chalk.dim("(")}${parts.join(chalk.dim(", "))}${chalk.dim(")")}`
          : "";
      }
      case "git_log": {
        const commits = obj["commits"] || obj;
        const count = Array.isArray(commits) ? commits.length : 0;
        return count > 0 ? ` ${chalk.dim(`(${count} commit${count !== 1 ? "s" : ""})`)}` : "";
      }
      case "grep": {
        const matches = obj["matches"] || obj;
        const count = Array.isArray(matches) ? matches.length : 0;
        return count > 0 ? ` ${chalk.dim(`(${count} match${count !== 1 ? "es" : ""})`)}` : "";
      }
      case "ls": {
        const items = obj["items"] || obj["files"] || obj;
        const count = Array.isArray(items) ? items.length : 0;
        return count > 0 ? ` ${chalk.dim(`(${count} item${count !== 1 ? "s" : ""})`)}` : "";
      }
      case "execute_command":
      case "execute_execute_command": {
        const exitCode = obj["exitCode"];
        const output = obj["output"];
        if (exitCode !== undefined && exitCode !== null) {
          const exitCodeNum = Number(exitCode);
          if (!isNaN(exitCodeNum) && exitCodeNum !== 0) {
            return ` ${chalk.red(`(exit: ${exitCodeNum})`)}`;
          }
        }
        if (output && typeof output === "string") {
          return ` ${chalk.dim(`(${output})`)}`;
        }
        return "";
      }
      case "http_request": {
        const status = obj["statusCode"];
        if (status !== undefined && status !== null) {
          const statusStr = safeString(status);
          return statusStr ? ` ${chalk.dim(`(${statusStr})`)}` : "";
        }
        return "";
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
        return "";
    }
  } catch {
    return "";
  }
}

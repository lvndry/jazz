import chalk from "chalk";
import { safeString } from "./string";

/**
 * Utility functions for formatting tool arguments and results
 * Used by both streaming and non-streaming modes
 */

/**
 * Format tool arguments for display
 * Shows relevant parameters for each tool type
 */
export function formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) {
    return "";
  }

  // Format arguments based on tool type
  switch (toolName) {
    case "read_file": {
      const path = safeString(args["path"] || args["filePath"]);
      return path ? ` ${chalk.dim("file:")} ${chalk.cyan(path)}` : "";
    }
    case "write_file": {
      const path = safeString(args["path"] || args["filePath"]);
      return path ? ` ${chalk.dim("file:")} ${chalk.cyan(path)}` : "";
    }
    case "cd": {
      const to = safeString(args["path"] || args["directory"]);
      return to ? ` ${chalk.dim("→")} ${chalk.cyan(to)}` : "";
    }
    case "grep": {
      const pattern = safeString(args["pattern"]);
      const path = safeString(args["path"]);
      const patternStr = pattern ? `${chalk.dim("pattern:")} ${chalk.cyan(pattern)}` : "";
      const pathStr = path ? ` ${chalk.dim(`in: ${path}`)}` : "";
      return patternStr + pathStr;
    }
    case "git_status":
      return "";
    case "git_log": {
      const limit = args["limit"];
      const limitStr = safeString(limit);
      return limitStr ? ` ${chalk.dim("limit:")} ${chalk.cyan(limitStr)}` : "";
    }
    case "git_diff":
      return "";
    case "git_commit": {
      const message = safeString(args["message"]);
      if (!message) return "";
      return ` ${chalk.dim("message:")} ${chalk.cyan(message.substring(0, 50))}`;
    }
    case "git_push": {
      const branch = safeString(args["branch"]);
      return branch ? ` ${chalk.dim("branch:")} ${chalk.cyan(branch)}` : "";
    }
    case "git_pull":
      return "";
    case "git_checkout": {
      const branchName = safeString(args["branch"]);
      return branchName ? ` ${chalk.dim("branch:")} ${chalk.cyan(branchName)}` : "";
    }
    case "execute_command":
    case "execute_command_approved": {
      const command = safeString(args["command"]);
      if (!command) return "";
      const truncated = command.substring(0, 60);
      return ` ${chalk.dim("command:")} ${chalk.cyan(truncated)}${command.length > 60 ? "..." : ""}`;
    }
    case "http_request": {
      const url = safeString(args["url"]);
      const method = safeString(args["method"] || "GET");
      if (!url) return "";
      const truncated = url.substring(0, 50);
      return ` ${chalk.dim(`${method}:`)} ${chalk.cyan(truncated)}${url.length > 50 ? "..." : ""}`;
    }
    case "web_search": {
      const query = safeString(args["query"]);
      if (!query) return "";
      const truncated = query.substring(0, 50);
      return ` ${chalk.dim("query:")} ${chalk.cyan(truncated)}${query.length > 50 ? "..." : ""}`;
    }
    case "ls": {
      const dir = safeString(args["path"]);
      return dir ? ` ${chalk.dim("dir:")} ${chalk.cyan(dir)}` : "";
    }
    case "find": {
      const searchPath = safeString(args["path"]);
      return searchPath ? ` ${chalk.dim("path:")} ${chalk.cyan(searchPath)}` : "";
    }
    case "mkdir": {
      const dirPath = safeString(args["path"]);
      return dirPath ? ` ${chalk.dim("path:")} ${chalk.cyan(dirPath)}` : "";
    }
    default: {
      // For unknown tools, show first few arguments
      const keys = Object.keys(args).slice(0, 2);
      if (keys.length === 0) return "";
      const parts = keys.map((key) => {
        const valueStr = safeString(args[key]).substring(0, 30);
        return `${chalk.dim(`${key}:`)} ${chalk.cyan(valueStr)}`;
      });
      return ` ${parts.join(", ")}`;
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
        return parts.length > 0 ? ` ${chalk.dim("(")}${parts.join(chalk.dim(", "))}${chalk.dim(")")}` : "";
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
      case "execute_command_approved": {
        const exitCode = obj["exitCode"];
        const output = obj["output"];
        if (exitCode !== undefined && exitCode !== null) {
          const exitCodeNum = Number(exitCode);
          if (!isNaN(exitCodeNum) && exitCodeNum !== 0) {
            return ` ${chalk.red(`(exit: ${exitCodeNum})`)}`;
          }
        }
        if (output && typeof output === "string") {
          const truncated = output.substring(0, 50);
          return ` ${chalk.dim(`(${truncated}${output.length >= 50 ? "..." : ""})`)}`;
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
      default:
        return "";
    }
  } catch {
    return "";
  }
}


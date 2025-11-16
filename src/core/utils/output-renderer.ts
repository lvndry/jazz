import chalk from "chalk";
import { Effect } from "effect";
import type { StreamEvent } from "../../services/llm/streaming-types";
import type { LLMError, ToolCall } from "../../services/llm/types";
import type { StreamingConfig } from "../types";
import { MarkdownRenderer } from "./markdown-renderer.js";

/**
 * Display configuration for rendering
 */
export interface DisplayConfig {
  readonly showThinking: boolean;
  readonly showToolExecution: boolean;
  readonly format: "plain" | "markdown";
}

/**
 * Output renderer for terminal display
 * Handles progressive rendering of streaming LLM responses and provides
 * utility methods for formatting tool output in both streaming and non-streaming modes
 */
export class OutputRenderer {
  private toolNameMap: Map<string, string> = new Map();

  constructor(
    private displayConfig: DisplayConfig,
    private streamingConfig: StreamingConfig,
    private showMetrics: boolean,
    private agentName: string,
  ) {}

  /**
   * Handle a streaming event and update terminal
   */
  handleEvent(event: StreamEvent): Effect.Effect<void, never> {
    return Effect.sync(() => {
      switch (event.type) {
        case "stream_start":
          this.renderStreamStart(event);
          break;

        case "thinking_start":
          if (this.displayConfig.showThinking) {
            this.renderThinkingStart();
          }
          break;

        case "thinking_chunk":
          if (this.displayConfig.showThinking) {
            this.renderThinkingChunk(event.content);
          }
          break;

        case "thinking_complete":
          if (this.displayConfig.showThinking) {
            this.renderThinkingComplete(event);
          }
          break;

        case "text_start":
          this.renderTextStart();
          break;

        case "text_chunk":
          this.renderTextChunk(event.delta);
          break;

        case "tool_call":
          this.renderToolCall(event.toolCall);
          break;

        case "tools_detected":
          if (this.displayConfig.showToolExecution) {
            this.renderToolsDetected(event);
          }
          break;

        case "tool_execution_start":
          if (this.displayConfig.showToolExecution) {
            this.renderToolExecutionStart(event);
          }
          break;

        case "tool_execution_complete":
          if (this.displayConfig.showToolExecution) {
            this.renderToolExecutionComplete(event);
          }
          break;

        case "usage_update":
          // Optional: show token usage (can be enabled later)
          break;

        case "error":
          this.renderError(event.error);
          break;

        case "complete":
          this.renderComplete(event);
          break;
      }
    });
  }

  private renderStreamStart(event: { provider: string; model: string }): void {
    console.log(`\n${chalk.bold.blue(this.agentName)} (${event.provider}/${event.model}):`);
  }

  private renderThinkingStart(): void {
    process.stdout.write(`\n${chalk.blue.bold("🧠 Agent Reasoning:")}\n${chalk.dim("─".repeat(60))}\n`);
  }

  private renderThinkingChunk(content: string): void {
    // Write thinking content in a readable format
    // Use blue color for better visibility while still distinguishing from main text
    process.stdout.write(chalk.blue(content));
  }

  private renderThinkingComplete(event?: { totalTokens?: number }): void {
    const totalTokens = event?.totalTokens;
    const tokenInfo = totalTokens ? chalk.dim(` (${totalTokens} reasoning tokens)`) : "";
    process.stdout.write(`\n${chalk.dim("─".repeat(60))}${tokenInfo}\n${chalk.green("✓ Reasoning complete")}\n\n`);
  }

  private renderTextStart(): void {
    // Start text section - no visual indicator needed
    // Text will start streaming immediately
  }

  private renderTextChunk(delta: string): void {
    if (this.streamingConfig.progressiveMarkdown && this.displayConfig.format === "markdown") {
      // Use markdown renderer to stream formatted output with buffering
      const bufferMs = this.streamingConfig.textBufferMs ?? 50;
      try {
        const rendered: string = MarkdownRenderer.renderChunk(delta, bufferMs);
        if (rendered.length > 0) {
          process.stdout.write(rendered);
        }
      } catch {
        // Fallback to plain text if markdown rendering fails
        process.stdout.write(delta);
      }
    } else {
      // Plain text streaming
      process.stdout.write(delta);
    }
  }

  private renderToolCall(_toolCall: ToolCall): void {
    // Note: Tool call detected, but don't execute yet
    // Agent runner will handle execution and emit tool_execution_start/complete events
    // We could show a subtle indicator here if needed
  }

  private renderToolsDetected(event: { toolNames: readonly string[]; agentName: string }): void {
    const tools = event.toolNames.join(", ");
    process.stdout.write(
      `\n${chalk.yellow("🔧")} ${chalk.yellow(event.agentName)} is using tools: ${chalk.cyan(tools)}\n`,
    );
  }

  /**
   * Utility method for safe string conversion (used in both streaming and non-streaming modes)
   */
  static safeString(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  /**
   * Format tool arguments for display (used in both streaming and non-streaming modes)
   */
  static formatToolArguments(toolName: string, args?: Record<string, unknown>): string {
    if (!args || Object.keys(args).length === 0) {
      return "";
    }

    // Format arguments based on tool type
    switch (toolName) {
      case "read_file": {
        const path = OutputRenderer.safeString(args["path"] || args["filePath"]);
        return path ? ` ${chalk.dim("file:")} ${chalk.cyan(path)}` : "";
      }
      case "write_file": {
        const path = OutputRenderer.safeString(args["path"] || args["filePath"]);
        return path ? ` ${chalk.dim("file:")} ${chalk.cyan(path)}` : "";
      }
      case "cd": {
        const to = OutputRenderer.safeString(args["path"] || args["directory"]);
        return to ? ` ${chalk.dim("→")} ${chalk.cyan(to)}` : "";
      }
      case "grep": {
        const pattern = OutputRenderer.safeString(args["pattern"]);
        const path = OutputRenderer.safeString(args["path"]);
        const patternStr = pattern ? `${chalk.dim("pattern:")} ${chalk.cyan(pattern)}` : "";
        const pathStr = path ? ` ${chalk.dim(`in: ${path}`)}` : "";
        return patternStr + pathStr;
      }
      case "git_status":
        return "";
      case "git_log": {
        const limit = args["limit"];
        const limitStr = OutputRenderer.safeString(limit);
        return limitStr ? ` ${chalk.dim("limit:")} ${chalk.cyan(limitStr)}` : "";
      }
      case "git_diff":
        return "";
      case "git_commit": {
        const message = OutputRenderer.safeString(args["message"]);
        if (!message) return "";
        return ` ${chalk.dim("message:")} ${chalk.cyan(message.substring(0, 50))}`;
      }
      case "git_push": {
        const branch = OutputRenderer.safeString(args["branch"]);
        return branch ? ` ${chalk.dim("branch:")} ${chalk.cyan(branch)}` : "";
      }
      case "git_pull":
        return "";
      case "git_checkout": {
        const branchName = OutputRenderer.safeString(args["branch"]);
        return branchName ? ` ${chalk.dim("branch:")} ${chalk.cyan(branchName)}` : "";
      }
      case "execute_command":
      case "execute_command_approved": {
        const command = OutputRenderer.safeString(args["command"]);
        if (!command) return "";
        const truncated = command.substring(0, 60);
        return ` ${chalk.dim("command:")} ${chalk.cyan(truncated)}${command.length > 60 ? "..." : ""}`;
      }
      case "http_request": {
        const url = OutputRenderer.safeString(args["url"]);
        const method = OutputRenderer.safeString(args["method"] || "GET");
        if (!url) return "";
        const truncated = url.substring(0, 50);
        return ` ${chalk.dim(`${method}:`)} ${chalk.cyan(truncated)}${url.length > 50 ? "..." : ""}`;
      }
      case "web_search": {
        const query = OutputRenderer.safeString(args["query"]);
        if (!query) return "";
        const truncated = query.substring(0, 50);
        return ` ${chalk.dim("query:")} ${chalk.cyan(truncated)}${query.length > 50 ? "..." : ""}`;
      }
      case "ls": {
        const dir = OutputRenderer.safeString(args["path"]);
        return dir ? ` ${chalk.dim("dir:")} ${chalk.cyan(dir)}` : "";
      }
      case "find": {
        const searchPath = OutputRenderer.safeString(args["path"]);
        return searchPath ? ` ${chalk.dim("path:")} ${chalk.cyan(searchPath)}` : "";
      }
      case "mkdir": {
        const dirPath = OutputRenderer.safeString(args["path"]);
        return dirPath ? ` ${chalk.dim("path:")} ${chalk.cyan(dirPath)}` : "";
      }
      default: {
        // For unknown tools, show first few arguments
        const keys = Object.keys(args).slice(0, 2);
        if (keys.length === 0) return "";
        const parts = keys.map((key) => {
          const valueStr = OutputRenderer.safeString(args[key]).substring(0, 30);
          return `${chalk.dim(`${key}:`)} ${chalk.cyan(valueStr)}`;
        });
        return ` ${parts.join(", ")}`;
      }
    }
  }

  /**
   * Format tool result for display (used in both streaming and non-streaming modes)
   */
  static formatToolResult(toolName: string, result: string): string {
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
          const newPath = OutputRenderer.safeString(obj["path"] || obj["currentDirectory"]);
          return newPath ? ` ${chalk.dim("→")} ${chalk.cyan(newPath)}` : "";
        }
        case "git_status": {
          const branch = OutputRenderer.safeString(obj["branch"]);
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
            const statusStr = OutputRenderer.safeString(status);
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

  private renderToolExecutionStart(event: {
    toolName: string;
    toolCallId: string;
    arguments?: Record<string, unknown>;
  }): void {
    // Store tool name for later use in completion
    this.toolNameMap.set(event.toolCallId, event.toolName);

    const argsStr = OutputRenderer.formatToolArguments(event.toolName, event.arguments);
    process.stdout.write(
      `\n${chalk.cyan("⚙️")}  Executing tool: ${chalk.cyan(event.toolName)}${argsStr}...`,
    );
  }

  private renderToolExecutionComplete(event: {
    toolCallId: string;
    result: string;
    durationMs: number;
    summary?: string;
  }): void {
    // Get tool name from map
    const toolName = this.toolNameMap.get(event.toolCallId) || "";
    const summary = event.summary || OutputRenderer.formatToolResult(toolName, event.result);
    process.stdout.write(
      ` ${chalk.green("✓")}${summary ? ` ${summary}` : ""} ${chalk.dim(`(${event.durationMs}ms)`)}\n`,
    );

    // Clean up
    this.toolNameMap.delete(event.toolCallId);
  }

  private renderError(error: LLMError): void {
    console.error(`\n${chalk.red("✗")} Error: ${error.message}\n`);
  }

  private renderComplete(event: {
    totalDurationMs: number;
    metrics?: {
      firstTokenLatencyMs: number;
      tokensPerSecond?: number;
      totalTokens?: number;
    };
  }): void {
    // Flush any remaining buffered markdown content
    if (this.streamingConfig.progressiveMarkdown && this.displayConfig.format === "markdown") {
      try {
        const remaining: string = MarkdownRenderer.flushBuffer();
        if (remaining.length > 0) {
          process.stdout.write(remaining);
        }
      } catch {
        // Silently ignore flush errors
      }
    }

    // Show metrics at the end if enabled and available
    if (this.showMetrics && event.metrics) {
      const parts: string[] = [];

      if (event.metrics.firstTokenLatencyMs) {
        parts.push(`First token: ${event.metrics.firstTokenLatencyMs}ms`);
      }

      if (event.metrics.tokensPerSecond) {
        parts.push(`Speed: ${event.metrics.tokensPerSecond.toFixed(1)} tok/s`);
      }

      if (event.metrics.totalTokens) {
        parts.push(`Total: ${event.metrics.totalTokens} tokens`);
      }

      if (parts.length > 0) {
        process.stdout.write(chalk.dim(`\n[${parts.join(" | ")}]\n`));
      }
    }

    // Ensure stdout is flushed and add clear separation before the next prompt
    // Use console.log to ensure proper flushing and newline handling
    console.log();
  }
}

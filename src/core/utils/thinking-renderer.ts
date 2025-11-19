import { RenderTheme } from "../types";

/**
 * Explicit state machine for thinking/reasoning rendering
 */
enum ThinkingState {
  Idle = "idle",
  Started = "started",
  HasContent = "has_content",
  Complete = "complete",
}

/**
 * Renders thinking/reasoning output with explicit state management
 * Handles the complex logic of showing reasoning progress and completion
 */
export class ThinkingRenderer {
  private state: ThinkingState = ThinkingState.Idle;
  private totalTokens: number | undefined = undefined;

  constructor(private theme: RenderTheme) {}

  /**
   * Handle thinking_start event
   * Returns the header to display, or null if nothing should be shown
   */
  handleStart(): string | null {
    if (this.state !== ThinkingState.Idle) {
      // Already started, ignore duplicate start event
      return null;
    }

    this.state = ThinkingState.Started;
    return this.formatStart();
  }

  /**
   * Handle thinking_chunk event
   * Returns the formatted chunk to display
   */
  handleChunk(content: string): string {
    if (this.state === ThinkingState.Idle) {
      // Received chunk without start - ignore
      return "";
    }

    // Mark that we have content
    if (this.state === ThinkingState.Started) {
      this.state = ThinkingState.HasContent;
    }

    return this.formatChunk(content);
  }

  /**
   * Handle thinking_complete event
   * Returns an object with:
   * - output: the text to display
   * - shouldClearLines: number of lines to clear before displaying (for updates)
   */
  handleComplete(tokens?: number): { output: string; shouldClearLines: number } {
    // Store tokens if provided
    if (tokens !== undefined) {
      this.totalTokens = tokens;
    }

    switch (this.state) {
      case ThinkingState.Idle:
        // Complete without start - check if we have tokens to display
        if (this.totalTokens !== undefined) {
          // This is a late token update after state was reset
          // Don't display anything - already showed completion
          return { output: "", shouldClearLines: 0 };
        }
        // Complete without start and no tokens - ignore silently
        return { output: "", shouldClearLines: 0 };

      case ThinkingState.Started:
        // Started but no content chunks received
        if (this.totalTokens !== undefined) {
          // Have tokens - show full completion
          this.state = ThinkingState.Complete;
          return {
            output: this.formatComplete(this.totalTokens),
            shouldClearLines: 0,
          };
        }
        // No content and no tokens - show minimal completion
        this.state = ThinkingState.Complete;
        return {
          output: this.formatCompleteMinimal(),
          shouldClearLines: 0,
        };

      case ThinkingState.HasContent:
        // We have content chunks
        if (this.totalTokens !== undefined) {
          // Have tokens - show full completion
          this.state = ThinkingState.Complete;
          return {
            output: this.formatComplete(this.totalTokens),
            shouldClearLines: 0,
          };
        }
        // Have content but no tokens yet - show completion without tokens
        // Keep state as HasContent to allow token update later
        return {
          output: this.formatComplete(undefined),
          shouldClearLines: 0,
        };

      case ThinkingState.Complete:
        // Already complete - this is a token update
        if (this.totalTokens !== undefined) {
          // Update the completion line with token info
          return {
            output: this.formatComplete(this.totalTokens),
            shouldClearLines: 2, // Clear separator and completion lines
          };
        }
        // Complete again without new info - ignore
        return { output: "", shouldClearLines: 0 };
    }
  }

  /**
   * Check if thinking is active (started or has content)
   */
  isActive(): boolean {
    return this.state === ThinkingState.Started || this.state === ThinkingState.HasContent;
  }

  /**
   * Reset state for new thinking session
   */
  reset(): void {
    this.state = ThinkingState.Idle;
    this.totalTokens = undefined;
  }

  /**
   * Format the thinking start header
   */
  private formatStart(): string {
    const { colors, icons, separatorChar, separatorWidth } = this.theme;
    return (
      "\n" +
      colors.thinking(`${icons.thinking} Agent Reasoning:`) +
      "\n" +
      colors.dim(separatorChar.repeat(separatorWidth)) +
      "\n"
    );
  }

  /**
   * Format a thinking content chunk
   */
  private formatChunk(content: string): string {
    return this.theme.colors.thinkingContent(content);
  }

  /**
   * Format the completion footer (with optional token count)
   */
  private formatComplete(tokens?: number): string {
    const { colors, icons, separatorChar, separatorWidth } = this.theme;
    const tokenInfo = tokens ? colors.dim(` (${tokens} reasoning tokens)`) : "";

    return (
      "\n" +
      colors.dim(separatorChar.repeat(separatorWidth)) +
      tokenInfo +
      "\n" +
      colors.success(`${icons.success} Reasoning complete`) +
      "\n\n"
    );
  }

  /**
   * Format minimal completion (no content received)
   */
  private formatCompleteMinimal(): string {
    const { colors, icons, separatorChar, separatorWidth } = this.theme;
    return (
      "\n" +
      colors.dim(separatorChar.repeat(separatorWidth)) +
      "\n" +
      colors.success(`${icons.success} Reasoning complete`) +
      "\n\n"
    );
  }
}


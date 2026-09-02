/**
 * `PresentationService` interface: abstracts rendering agent output (status,
 * streaming, approvals, user input) so core logic stays independent of the
 * concrete surface (CLI, Ink, headless, Telegram, etc.).
 */
import { Context, Effect } from "effect";
import type { StreamEvent, StreamingConfig } from "@/core/types/streaming";
import type { ApprovalOutcome, ApprovalRequest } from "@/core/types/tools";
import type { DisplayConfig } from "../types";

/**
 * A suggested response with optional label and description.
 */
export interface Suggestion {
  /** The value to return when this suggestion is picked */
  readonly value: string;
  /** Optional label to display instead of the value */
  readonly label?: string | undefined;
  /** Optional detailed description to display below the suggestion */
  readonly description?: string | undefined;
}

/**
 * What came back from asking the human.
 *
 * "Nobody was there" and "they said no" call for opposite behaviour — the first
 * leaves the decision to the agent, the second is the human's decision and must
 * not be overridden by guessing — so they are distinct outcomes rather than one
 * empty string. Submitting nothing is a refusal: the question was seen.
 */
export type UserInputOutcome =
  /** They answered. `response` is non-empty. */
  | { readonly kind: "answered"; readonly response: string }
  /** They were asked and declined — dismissed the prompt or entered nothing. */
  | { readonly kind: "declined" }
  /** Nobody could be asked. No human ever saw this question. */
  | { readonly kind: "unavailable" };

/**
 * Request for user input with optional suggested responses.
 * Used by the ask_user tool to gather clarifications.
 */
export interface UserInputRequest {
  /** The question to display to the user */
  readonly question: string;
  /** Optional suggested responses the user can pick from */
  readonly suggestions: readonly Suggestion[];
  /** Whether to allow custom text input in addition to suggestions */
  readonly allowCustom: boolean;
  /** Whether to allow selecting multiple suggestions (default: false, single selection) */
  readonly allowMultiple?: boolean;
}

/**
 * Request for file picker input.
 * Used by the ask_file_picker tool to let users select files interactively.
 */
export interface FilePickerRequest {
  /** The prompt message to display */
  readonly message: string;
  /** Starting directory for file search (defaults to cwd) */
  readonly basePath?: string | undefined;
  /** Filter by file extensions (without leading dot, e.g. ["ts", "tsx"]) */
  readonly extensions?: readonly string[] | undefined;
  /** Whether to include directories in results (default: false) */
  readonly includeDirectories?: boolean | undefined;
}

/**
 * Presentation service interface for rendering agent output
 *
 * This interface abstracts presentation concerns from core business logic,
 * allowing different presentation implementations (CLI, web, API, etc.)
 * while keeping core logic independent of presentation details.
 */
export interface PresentationService {
  /**
   * Present a thinking/processing status to the user
   */
  readonly presentThinking: (
    agentName: string,
    isFirstIteration: boolean,
  ) => Effect.Effect<void, never>;

  /**
   * Present a completion status to the user
   */
  readonly presentCompletion: (agentName: string) => Effect.Effect<void, never>;

  /**
   * Present a warning to the user
   */
  readonly presentWarning: (agentName: string, message: string) => Effect.Effect<void, never>;

  /**
   * Present an agent response to the user
   */
  readonly presentAgentResponse: (agentName: string, content: string) => Effect.Effect<void, never>;

  /**
   * Render markdown content to formatted text
   */
  readonly renderMarkdown: (markdown: string) => Effect.Effect<string, never>;

  /**
   * Format tool arguments for display
   */
  readonly formatToolArguments: (toolName: string, args?: Record<string, unknown>) => string;

  /**
   * Format tool result for display
   */
  readonly formatToolResult: (toolName: string, result: string) => string;

  /**
   * Format tool execution start message
   */
  readonly formatToolExecutionStart: (
    toolName: string,
    args?: Record<string, unknown>,
    options?: { readonly metadata?: Record<string, unknown> },
  ) => Effect.Effect<string, never>;

  /**
   * Format tool execution complete message (success)
   */
  readonly formatToolExecutionComplete: (
    summary: string | null,
    durationMs: number,
  ) => Effect.Effect<string, never>;

  /**
   * Format tool execution error message
   */
  readonly formatToolExecutionError: (
    errorMessage: string,
    durationMs: number,
  ) => Effect.Effect<string, never>;

  /**
   * Format tools detected message
   */
  readonly formatToolsDetected: (
    agentName: string,
    toolNames: readonly string[],
    toolsRequiringApproval: readonly string[],
  ) => Effect.Effect<string, never>;

  /**
   * Create a streaming renderer for real-time output
   */
  readonly createStreamingRenderer: (
    config: StreamingRendererConfig,
  ) => Effect.Effect<StreamingRenderer, never>;

  /**
   * Whether tool lifecycle events must be routed through a streaming renderer
   * even on the non-streaming (batch) execution path.
   *
   * The headless one-shot service uses the renderer as its only `--events`
   * NDJSON emit seam, so it returns true when events are requested. Visual
   * services (CLI, Ink) render tool activity through their own `format*`
   * fallbacks in batch mode and return false to keep that behavior unchanged.
   */
  readonly emitsToolEventsViaRenderer?: () => boolean;

  /**
   * Write output directly (for non-streaming mode).
   *
   * @param agentName - Who produced the content, when the caller knows. Visual
   *   implementations ignore it; the NDJSON emitter puts it on the line, so a
   *   consumer can tell which of several concurrent sub-agents is speaking.
   */
  readonly writeOutput: (message: string, agentName?: string) => Effect.Effect<void, never>;

  /**
   * Write a blank line
   */
  readonly writeBlankLine: () => Effect.Effect<void, never>;

  /**
   * Present a status message to the user.
   *
   * Used for operational status updates like service connections, setup progress, etc.
   * Unlike writeOutput (which is for agent content), this is for system-level status.
   *
   * Implementations:
   * - Ink (interactive): renders with colors/icons via the Ink store
   * - CLI (non-TTY): writes plain text with prefix to stdout
   * - Quiet (background): no-op (silent)
   *
   * @param message - The status message to display
   * @param level - The type of status: info, success, warning, error, or progress
   * @param agentName - Which agent the status is about, when the caller knows.
   *   Carried on the NDJSON line for the same reason as {@link writeOutput}.
   */
  readonly presentStatus: (
    message: string,
    level: "info" | "success" | "warning" | "error" | "progress",
    agentName?: string,
  ) => Effect.Effect<void, never>;

  /**
   * Open a bounded live region for in-flight work (sub-agent panel, later
   * reasoning). Returns a region id the caller must pass to append/collapse.
   *
   * Ink renders a last-N-lines panel; headless and quiet implementations
   * return a dummy id and no-op the rest of the lifecycle.
   */
  readonly openEphemeralRegion: (
    kind: EphemeralRegionKind,
    label: string,
  ) => Effect.Effect<string, never>;

  /**
   * Append text to an open live region. No-op if the region is unknown.
   */
  readonly appendEphemeralRegion: (regionId: string, text: string) => Effect.Effect<void, never>;

  /**
   * Close a live region and emit a one-line summary. Safe to call if the
   * region was never opened (headless no-ops).
   */
  readonly collapseEphemeralRegion: (
    regionId: string,
    label: string,
    outcome: EphemeralRegionCollapse,
  ) => Effect.Effect<void, never>;

  /**
   * Request user approval for a tool action.
   *
   * Shows a confirmation prompt with details about what action will be performed.
   * The user can approve (Yes) or reject (No). When rejecting, the user may optionally
   * provide a message to guide the agent (e.g. "Don't bump version; do X instead").
   *
   * This enables the Cursor/Claude-style approval flow where:
   * 1. A tool returns approvalRequired: true
   * 2. The system intercepts this and shows approval UI
   * 3. If approved, the system automatically calls the execution tool
   * 4. If rejected, the optional userMessage is passed to the LLM so it can adjust
   * 5. The combined result is returned to the LLM
   *
   * @param request - The approval request containing tool info and action details
   * @returns ApprovalOutcome: { approved: true } or { approved: false, userMessage?: string }
   */
  readonly requestApproval: (request: ApprovalRequest) => Effect.Effect<ApprovalOutcome, never>;

  /**
   * Signal that tool execution has started after approval.
   *
   * This should be called by the tool executor after emitting `tool_execution_start`
   * to synchronize the approval queue. The next approval prompt will not be shown
   * until this signal is received, preventing log interleaving.
   */
  /**
   * Report the reachability of a named connector, so an interface can show
   * whether the things the agent depends on are actually available.
   *
   * Optional: only presentations that render persistent chrome have anywhere to
   * put it, and a one-shot run has nothing to gain from it.
   */
  readonly reportConnector?: (
    name: string,
    status: "live" | "renew" | "offline",
  ) => Effect.Effect<void, never>;

  /**
   * Whether `requestApproval` can actually put the decision in front of a
   * person and wait for an answer.
   *
   * The approval tiers read differently depending on the answer: skipping a
   * prompt is a convenience where a prompt was the alternative, and a widening
   * of unsupervised authority where it was not. A presentation that omits this
   * is treated as unable to ask, which is the safe reading.
   */
  readonly canPromptForApproval?: () => boolean;

  readonly signalToolExecutionStarted: () => Effect.Effect<void, never>;

  /**
   * Request input from the user with optional suggested responses.
   *
   * Displays a question to the user with optional suggested responses they can select from.
   * The user can either pick a suggestion or type a custom response (if allowCustom is true).
   * Used by the ask_user tool to gather clarifications before proceeding.
   *
   * @param request - The user input request with question and optional suggestions
   * @returns The user's response (either selected suggestion or custom text)
   */
  readonly requestUserInput: (request: UserInputRequest) => Effect.Effect<UserInputOutcome, never>;

  /**
   * Request file selection from the user with fuzzy path filtering.
   *
   * Displays a file picker interface where the user can type to filter files
   * and navigate through matching results. Used by the ask_file_picker tool.
   *
   * @param request - The file picker request with message and optional filters
   * @returns The selected file path (absolute)
   */
  readonly requestFilePicker: (request: FilePickerRequest) => Effect.Effect<string, never>;
}

/**
 * Where the renderer should write streamed reasoning + response deltas.
 *
 * - `scrollback` (default): the global pending streaming buffer in the
 *   scrollback. Use for the main agent's user-facing response.
 * - `ephemeral`: a bounded live region identified by `regionId`. Use for
 *   subagent runs and (later) reasoning that should not occupy scrollback.
 */
export type StreamTarget =
  { readonly kind: "scrollback" } | { readonly kind: "ephemeral"; readonly regionId: string };

/**
 * Kind of bounded live region. Matches the Ink store's ephemeral kinds so
 * the TUI can pick label styling and panel size.
 */
export type EphemeralRegionKind = "reasoning" | "subagent";

/**
 * How a live region ended. Ink formats the collapse line; core only reports
 * the outcome so it never imports chalk or glyphs.
 */
export interface EphemeralRegionCollapse {
  readonly status: "completed" | "failed" | "interrupted";
  readonly durationMs: number;
  /** Total spend for the run this region tracked, when pricing was available. */
  readonly costUSD?: number;
  /** Total prompt + completion tokens for the run this region tracked. */
  readonly totalTokens?: number;
}

/**
 * Configuration for creating a streaming renderer
 */
export interface StreamingRendererConfig {
  readonly displayConfig: DisplayConfig;
  readonly streamingConfig: StreamingConfig;
  readonly showMetrics: boolean;
  readonly agentName: string;
  readonly reasoningEffort?: "disable" | "low" | "medium" | "high" | undefined;
  /** Optional override of where streamed deltas are routed. Default: scrollback. */
  readonly streamTarget?: StreamTarget;
}

/**
 * Streaming renderer interface for handling real-time stream events
 */
export interface StreamingRenderer {
  /**
   * Handle a streaming event
   */
  readonly handleEvent: (event: StreamEvent) => Effect.Effect<void, never>;

  /**
   * Register or clear a user interrupt handler for the active stream.
   */
  readonly setInterruptHandler: (handler: (() => void) | null) => Effect.Effect<void, never>;

  /**
   * Register or clear a "detach the in-flight tool call into the background" handler
   * (Ctrl+B) for the active stream. Optional — only a UI that can offer that chord
   * (the Ink renderer) implements it; other presentation modes simply have no way to
   * trigger it, which is the correct behavior for them, not a missing feature.
   */
  readonly setBackgroundHandler?: (handler: (() => void) | null) => Effect.Effect<void, never>;

  /**
   * Reset renderer state (call between conversations)
   */
  readonly reset: () => Effect.Effect<void, never>;

  /**
   * Flush any pending output
   */
  readonly flush: () => Effect.Effect<void, never>;
}

/**
 * Service tag for dependency injection
 */
export const PresentationServiceTag =
  Context.GenericTag<PresentationService>("PresentationService");

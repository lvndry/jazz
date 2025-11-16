# Streaming Implementation - Technical Design Document

## Executive Summary

Implement production-grade streaming for Jazz CLI with smart defaults, backward compatibility, and
world-class UX. Streaming is **optional** but **automatically enabled** when appropriate.

---

## Design Principles

### 1. **Backward Compatibility First**

- Existing code must work without changes
- No breaking changes to public APIs
- Legacy behavior preserved by default

### 2. **Smart Defaults, User Control**

- Auto-detect when to stream (TTY, interactive sessions)
- User can override with config or CLI flags
- Graceful degradation if streaming fails

### 3. **Production-Grade Quality**

- Proper error handling and recovery
- Resource cleanup (Ctrl+C handling)
- Performance optimized (buffering, backpressure)
- Comprehensive testing

### 4. **Effect-TS Native**

- Use Effect.Stream for streaming abstraction
- Proper resource management with scopes
- Type-safe event handling
- Composable stream operations

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLI Layer                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐     │
│  │ chat-agent   │  │ task-agent   │  │ Other Commands   │     │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘     │
│         │                 │                    │                │
│         └─────────────────┴────────────────────┘                │
│                           ↓                                     │
│                  ┌─────────────────┐                            │
│                  │ StreamDetector  │ (TTY check, config)        │
│                  └────────┬────────┘                            │
└───────────────────────────┼─────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                      Agent Runner                               │
│  ┌──────────────────────────────────────────────────────┐       │
│  │  IF streaming enabled:                               │       │
│  │    - Call createStreamingChatCompletion()            │       │
│  │    - Process stream with StreamConsumer              │       │
│  │  ELSE:                                               │       │
│  │    - Call createChatCompletion() (existing)          │       │
│  └──────────────────────────────────────────────────────┘       │
└───────────────────────────┼─────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                     LLM Service Layer                           │
│  ┌────────────────────────────────────────────────────┐         │
│  │  createChatCompletion() [Existing - No Changes]    │         │
│  │    - Uses generateText() from AI SDK               │         │
│  │    - Returns complete response                     │         │
│  └────────────────────────────────────────────────────┘         │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐         │
│  │  createStreamingChatCompletion() [NEW]             │         │
│  │    - Uses streamText() from AI SDK                 │         │
│  │    - Returns Effect.Stream<StreamEvent, Error>     │         │
│  │    - Emits structured events                       │         │
│  └────────────────────────────────────────────────────┘         │
└───────────────────────────┼─────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    Terminal Renderer                            │
│  ┌────────────┐  ┌─────────────┐  ┌───────────────────┐        │
│  │ Markdown   │  │  Thinking   │  │  Tool Execution   │        │
│  │ Renderer   │  │  Indicator  │  │  UI               │        │
│  └────────────┘  └─────────────┘  └───────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Type System Design

### Core Types

```typescript
// streaming-types.ts - New file

/**
 * Structured streaming events
 */
export type StreamEvent =
  | { type: "stream_start"; provider: string; model: string; timestamp: number }
  | { type: "thinking_start"; provider: string }
  | { type: "thinking_chunk"; content: string; sequence: number }
  | { type: "thinking_complete"; totalTokens?: number }
  | { type: "text_start" }
  | { type: "text_chunk"; delta: string; accumulated: string; sequence: number }
  | { type: "tool_call"; toolCall: ToolCall; sequence: number }
  | { type: "tool_execution_start"; toolName: string; toolCallId: string }
  | { type: "tool_execution_complete"; toolCallId: string; result: string; durationMs: number }
  | { type: "usage_update"; usage: TokenUsage }
  | { type: "error"; error: LLMError; recoverable: boolean }
  | {
      type: "complete";
      response: ChatCompletionResponse;
      totalDurationMs: number;
      /**
       * Performance metrics (only included if logging.showMetrics is enabled)
       */
      metrics?: {
        firstTokenLatencyMs: number;
        tokensPerSecond?: number;
        totalTokens?: number;
      };
    };

/**
 * Streaming configuration
 */
export interface StreamingConfig {
  enabled: boolean;
  showThinking: boolean;
  showToolExecution: boolean;
  progressiveMarkdown: boolean;
  textBufferMs: number;
}

/**
 * Result of streaming operation
 */
export interface StreamingResult {
  // The event stream
  stream: Stream.Stream<StreamEvent, LLMError>;

  // Effect that completes with final response
  // Consumers can either:
  // 1. Process the stream for real-time updates
  // 2. Just await the response for final result
  response: Effect.Effect<ChatCompletionResponse, LLMError>;

  // Cancel/abort the streaming operation
  // Uses AbortSignal internally to cancel the AI SDK request
  cancel: Effect.Effect<void, never>;
}
```

### Updated LLM Service Interface

```typescript
// types.ts - Updated

export interface LLMService {
  // Existing - NO CHANGES
  readonly getProvider: (name: string) => Effect.Effect<LLMProvider, LLMConfigurationError>;
  readonly listProviders: () => Effect.Effect<readonly string[], never>;
  readonly createChatCompletion: (
    provider: string,
    options: ChatCompletionOptions,
  ) => Effect.Effect<ChatCompletionResponse, LLMError>;

  // NEW - Streaming method
  readonly createStreamingChatCompletion: (
    provider: string,
    options: ChatCompletionOptions,
  ) => Effect.Effect<StreamingResult, LLMError>;
}
```

---

## Implementation Phases

### Phase 1: Foundation (Day 1)

#### 1.1 Create Type System

- [ ] Create `src/services/llm/streaming-types.ts`
- [ ] Define `StreamEvent` discriminated union
- [ ] Define `StreamingConfig` interface
- [ ] Define `StreamingResult` interface
- [ ] Export default streaming config

#### 1.2 Update LLM Service Interface

- [ ] Add `createStreamingChatCompletion` to `LLMService` interface
- [ ] Update `ChatCompletionOptions` to include optional `streamingConfig`
- [ ] Keep existing methods unchanged

#### 1.3 Stream Detection Utility

- [ ] Create `src/core/utils/stream-detector.ts`
- [ ] Implement TTY detection
- [ ] Implement config-based override
- [ ] Implement environment variable support

```typescript
// stream-detector.ts
export interface StreamDetectionResult {
  shouldStream: boolean;
  reason: string;
}

export function shouldEnableStreaming(
  config: AppConfig,
  options?: { forceStream?: boolean; forceNoStream?: boolean },
): StreamDetectionResult {
  // 1. Explicit CLI override
  if (options?.forceNoStream) {
    return { shouldStream: false, reason: "explicit-disable" };
  }
  if (options?.forceStream) {
    return { shouldStream: true, reason: "explicit-enable" };
  }

  // 2. Config file setting
  if (config.output?.streaming?.enabled === false) {
    return { shouldStream: false, reason: "config-disabled" };
  }
  if (config.output?.streaming?.enabled === true) {
    return { shouldStream: true, reason: "config-enabled" };
  }

  // 3. Environment detection
  if (process.env.NO_COLOR || process.env.CI) {
    return { shouldStream: false, reason: "ci-environment" };
  }

  // 4. Test environment
  if (process.env.NODE_ENV === "test") {
    return { shouldStream: false, reason: "test-environment" };
  }

  // 5. Output piping detection
  if (!process.stdout.isTTY) {
    return { shouldStream: false, reason: "non-tty" };
  }

  // 6. Default: enable for interactive terminals
  return { shouldStream: true, reason: "auto-detected-tty" };
}
```

---

### Phase 2: Core Streaming Implementation (Day 2)

#### 2.1 AI SDK Service - Streaming Method

```typescript
// ai-sdk-service.ts - Add new method

class DefaultAISDKService implements LLMService {
  // ... existing methods unchanged ...

  /**
   * Create streaming chat completion
   */
  createStreamingChatCompletion(
    providerName: string,
    options: ChatCompletionOptions,
  ): Effect.Effect<StreamingResult, LLMError> {
    return Effect.gen(function* () {
      const model = selectModel(providerName, options.model);
      const tools = prepareTools(options.tools); // Existing helper
      const providerOptions = buildProviderOptions(providerName, options);

      // Create AbortController for cancellation
      const abortController = new AbortController();

      // Create a deferred to collect final response
      const responseDeferred = yield* Effect.promise(() =>
        Promise.withResolvers<ChatCompletionResponse>(),
      );

      // Create the stream
      const stream = Stream.asyncEffect<StreamEvent, LLMError>((emit) =>
        Effect.gen(function* () {
          const startTime = Date.now();
          let firstTokenTime: number | null = null;

          try {
            // Emit start event
            yield* emit.single({
              type: "stream_start",
              provider: providerName,
              model: options.model,
              timestamp: startTime,
            });

            // Use AI SDK streamText with AbortSignal
            const result = await streamText({
              model,
              messages: toCoreMessages(options.messages),
              temperature: options.temperature,
              tools,
              providerOptions,
              abortSignal: abortController.signal, // Add abort support
            });

            let accumulatedText = "";
            let textSequence = 0;
            let reasoningSequence = 0;
            let hasStartedText = false;
            let hasStartedReasoning = false;

            // Process fullStream for all events (text, reasoning, tool calls)
            for await (const part of result.fullStream) {
              // Record first token time (for metrics calculation at the end)
              if (!firstTokenTime) {
                firstTokenTime = Date.now();
              }

              switch (part.type) {
                case "text-delta":
                  // Emit text start on first text chunk
                  if (!hasStartedText) {
                    yield* emit.single({ type: "text_start" });
                    hasStartedText = true;
                  }

                  accumulatedText += part.textDelta;
                  yield* emit.single({
                    type: "text_chunk",
                    delta: part.textDelta,
                    accumulated: accumulatedText,
                    sequence: textSequence++,
                  });
                  break;

                case "reasoning-part-finish":
                  // Reasoning/thinking from models like o1, Claude extended thinking
                  if (!hasStartedReasoning) {
                    yield* emit.single({ type: "thinking_start", provider: providerName });
                    hasStartedReasoning = true;
                  }

                  yield* emit.single({
                    type: "thinking_chunk",
                    content: part.text,
                    sequence: reasoningSequence++,
                  });
                  break;

                case "tool-call":
                  // Tool call detected
                  const toolCall: ToolCall = {
                    id: part.toolCallId,
                    type: "function",
                    function: {
                      name: part.toolName,
                      arguments: JSON.stringify(part.input),
                    },
                  };

                  yield* emit.single({
                    type: "tool_call",
                    toolCall,
                    sequence: textSequence++,
                  });
                  break;

                case "finish":
                  // Final completion event from AI SDK
                  if (hasStartedReasoning) {
                    yield* emit.single({
                      type: "thinking_complete",
                      totalTokens: part.totalUsage?.reasoningTokens,
                    });
                  }
                  break;

                case "error":
                  // Error during streaming
                  throw part.error;
              }
            }

            // Stream is complete, get final values
            await result.finished;

            // Get final results (await promises)
            const finalText = await result.text;
            const finalToolCalls = await result.toolCalls;
            const finalUsage = await result.usage;

            // Build usage object
            const usage = finalUsage
              ? {
                  promptTokens: finalUsage.inputTokens ?? 0,
                  completionTokens: finalUsage.outputTokens ?? 0,
                  totalTokens: finalUsage.totalTokens ?? 0,
                }
              : undefined;

            if (usage) {
              yield* emit.single({ type: "usage_update", usage });
            }

            // Calculate metrics for complete event (if enabled via logging.showMetrics)
            // Metrics are only included in the complete event, not emitted separately
            let metrics:
              | { firstTokenLatencyMs: number; tokensPerSecond?: number; totalTokens?: number }
              | undefined;
            if (firstTokenTime && usage?.totalTokens) {
              const totalDuration = Date.now() - startTime;
              const tokensPerSecond = (usage.totalTokens / totalDuration) * 1000;
              metrics = {
                firstTokenLatencyMs: firstTokenTime - startTime,
                tokensPerSecond,
                totalTokens: usage.totalTokens,
              };
            }

            // Convert AI SDK tool calls to our format
            const toolCalls =
              finalToolCalls && finalToolCalls.length > 0
                ? finalToolCalls.map((tc) => ({
                    id: tc.toolCallId,
                    type: "function" as const,
                    function: {
                      name: tc.toolName,
                      arguments: JSON.stringify(tc.input),
                    },
                  }))
                : undefined;

            // Build final response
            const finalResponse: ChatCompletionResponse = {
              id: "",
              model: options.model,
              content: finalText, // Use final text from AI SDK
              toolCalls,
              usage,
            };

            // Emit complete event with metrics (if calculated)
            const endTime = Date.now();
            yield* emit.single({
              type: "complete",
              response: finalResponse,
              totalDurationMs: endTime - startTime,
              ...(metrics ? { metrics } : {}),
            });

            // Resolve the deferred with final response
            responseDeferred.resolve(finalResponse);
          } catch (error) {
            // Convert to LLM error
            const llmError = convertToLLMError(error, providerName);

            // Emit error event
            yield* emit.single({
              type: "error",
              error: llmError,
              recoverable: false,
            });

            // Reject the deferred
            responseDeferred.reject(llmError);

            yield* emit.fail(llmError);
          }
        }),
      );

      // Return streaming result with cancellation support
      return {
        stream,
        response: Effect.promise(() => responseDeferred.promise),
        cancel: Effect.sync(() => {
          abortController.abort();
        }),
      };
    });
  }
}
```

#### 2.2 Helper Functions

```typescript
// Convert AI SDK errors to LLM errors
function convertToLLMError(error: unknown, provider: string): LLMError {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode = extractStatusCode(error);

  if (statusCode === 401 || statusCode === 403) {
    return new LLMAuthenticationError(provider, message);
  } else if (statusCode === 429) {
    return new LLMRateLimitError(provider, message);
  } else {
    return new LLMRequestError(provider, message);
  }
}

// Note: Tool call extraction is now inline in the main function
// AI SDK's streamText returns tool calls in fullStream and as a promise
```

---

### Phase 3: Terminal Rendering (Day 3)

#### 3.1 Stream Consumer / Renderer

```typescript
// src/core/utils/stream-renderer.ts

export class StreamRenderer {
  private thinkingSection: string[] = [];
  private textContent: string = "";
  private toolExecutions: Map<string, ToolExecution> = new Map();

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
            this.renderThinkingComplete();
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
          // Optional: show token usage
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
    console.log(`\n${this.agentName} (${event.provider}/${event.model}):`);
  }

  private renderThinkingStart(): void {
    process.stdout.write("\n🧠 Thinking...\n");
  }

  private renderThinkingChunk(content: string): void {
    // Write thinking content in dimmed color
    process.stdout.write(chalk.dim(content));
  }

  private renderThinkingComplete(): void {
    process.stdout.write(chalk.dim(" ✓\n\n"));
  }

  private renderTextStart(): void {
    // Start text section
  }

  private renderTextChunk(delta: string): void {
    if (this.streamingConfig.progressiveMarkdown && this.displayConfig.format === "markdown") {
      // Use markdown renderer to stream formatted output
      const rendered = MarkdownRenderer.renderChunk(delta);
      process.stdout.write(rendered);
    } else {
      // Plain text streaming
      process.stdout.write(delta);
    }
  }

  private renderToolCall(toolCall: ToolCall): void {
    // Note: Tool call detected, but don't execute yet
    // Agent runner will handle execution
  }

  private renderToolExecutionStart(event: { toolName: string; toolCallId: string }): void {
    process.stdout.write(`\n⚙️  Executing tool: ${chalk.cyan(event.toolName)}...`);
  }

  private renderToolExecutionComplete(event: { result: string; durationMs: number }): void {
    process.stdout.write(` ${chalk.green("✓")} (${event.durationMs}ms)\n`);
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
    process.stdout.write(`\n\n`);

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
        process.stdout.write(chalk.dim(`\n[${parts.join(" | ")}]`));
      }
    }
  }
}
```

#### 3.2 Progressive Markdown Renderer

```typescript
// src/core/utils/markdown-renderer.ts - Extend existing

export class MarkdownRenderer {
  private static buffer: string = "";

  /**
   * Render markdown chunk progressively
   * Buffers incomplete syntax constructs
   */
  static renderChunk(delta: string): string {
    this.buffer += delta;

    // Check if we have complete markdown constructs
    // For now, simple word-based buffering
    if (this.buffer.endsWith(" ") || this.buffer.endsWith("\n")) {
      const toRender = this.buffer;
      this.buffer = "";

      // Apply basic markdown formatting
      return this.applyFormatting(toRender);
    }

    // Hold incomplete words
    return "";
  }

  private static applyFormatting(text: string): string {
    // Apply bold, italic, code formatting on the fly
    let formatted = text;

    // Bold: **text**
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (_, p1) => chalk.bold(p1));

    // Italic: *text*
    formatted = formatted.replace(/\*([^*]+)\*/g, (_, p1) => chalk.italic(p1));

    // Inline code: `code`
    formatted = formatted.replace(/`([^`]+)`/g, (_, p1) => chalk.cyan(p1));

    // Headers: # Header
    formatted = formatted.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, title) =>
      chalk.bold.blue(title),
    );

    return formatted;
  }

  static reset(): void {
    this.buffer = "";
  }
}
```

---

### Phase 4: Agent Runner Integration (Day 4)

#### 4.1 Update Agent Runner

```typescript
// agent-runner.ts - Add streaming support

export class AgentRunner {
  static run(options: AgentRunnerOptions): Effect.Effect<AgentResponse, Error, Dependencies> {
    return Effect.gen(function* () {
      const llmService = yield* LLMServiceTag;
      const configService = yield* AgentConfigService;
      const appConfig = yield* configService.appConfig;

      // Determine if streaming should be enabled
      const streamDetection = shouldEnableStreaming(appConfig, {
        forceStream: options.forceStream,
        forceNoStream: options.forceNoStream,
      });

      // Get display config with defaults (applies to both modes)
      const displayConfig: DisplayConfig = {
        showThinking: appConfig.output?.showThinking ?? DEFAULT_DISPLAY_CONFIG.showThinking,
        showToolExecution:
          appConfig.output?.showToolExecution ?? DEFAULT_DISPLAY_CONFIG.showToolExecution,
        format: appConfig.output?.format ?? DEFAULT_DISPLAY_CONFIG.format,
      };

      // Check if we should show metrics (from logging config)
      const showMetrics = appConfig.logging?.showMetrics ?? false;

      // Get streaming config with defaults (streaming-specific)
      const streamingConfig: StreamingConfig = {
        enabled: appConfig.output?.streaming?.enabled ?? DEFAULT_STREAMING_CONFIG.enabled,
        progressiveMarkdown:
          appConfig.output?.streaming?.progressiveMarkdown ??
          DEFAULT_STREAMING_CONFIG.progressiveMarkdown,
        textBufferMs:
          appConfig.output?.streaming?.textBufferMs ?? DEFAULT_STREAMING_CONFIG.textBufferMs,
      };

      if (streamDetection.shouldStream) {
        // Use streaming path
        return yield* this.runWithStreaming(options, displayConfig, streamingConfig, showMetrics);
      } else {
        // Use non-streaming path (but still apply display config)
        return yield* this.runWithoutStreaming(options, displayConfig, showMetrics);
      }
    });
  }

  /**
   * New streaming implementation
   */
  private static runWithStreaming(
    options: AgentRunnerOptions,
    displayConfig: DisplayConfig,
    streamingConfig: StreamingConfig,
    showMetrics: boolean,
  ): Effect.Effect<AgentResponse, Error, Dependencies> {
    return Effect.gen(function* () {
      const llmService = yield* LLMServiceTag;
      const { agent, userInput } = options;

      // Create stream renderer (uses both display and streaming config)
      const renderer = new StreamRenderer(displayConfig, streamingConfig, showMetrics, agent.name);

      // Prepare LLM options
      const llmOptions: ChatCompletionOptions = {
        model: agent.config.llmModel,
        messages: prepareMessages(options), // Existing helper
        tools: prepareTools(agent), // Existing helper
        streamingConfig,
      };

      // Create streaming completion
      const streamingResult = yield* llmService.createStreamingChatCompletion(
        agent.config.llmProvider,
        llmOptions,
      );

      // Process stream events
      yield* Stream.runForEach(streamingResult.stream, (event) => renderer.handleEvent(event));

      // Get final response
      const response = yield* streamingResult.response;

      // Handle tool calls if present (existing logic)
      if (response.toolCalls && response.toolCalls.length > 0) {
        // Execute tools and continue conversation
        // ... existing tool execution logic ...
      }

      return {
        conversationId: options.conversationId ?? `conv-${Date.now()}`,
        content: response.content,
        messages: buildMessageHistory(options, response),
      };
    });
  }

  /**
   * Non-streaming implementation (now also uses display config)
   */
  private static runWithoutStreaming(
    options: AgentRunnerOptions,
    displayConfig: DisplayConfig,
    showMetrics: boolean,
  ): Effect.Effect<AgentResponse, Error, Dependencies> {
    return Effect.gen(function* () {
      // ... existing code but now considers displayConfig ...
      // - Hide thinking if displayConfig.showThinking === false
      // - Hide tool execution if displayConfig.showToolExecution === false
      // - Format output based on displayConfig.format
      // - Show metrics if showMetrics === true (from logging config)
    });
  }
}
```

---

### Phase 5: CLI Integration (Day 5)

#### 5.1 Update Chat Agent Command

```typescript
// cli/commands/chat-agent.ts - Add streaming flags

export function chatWithAIAgentCommand(
  agentIdentifier: string,
  options: {
    stream?: boolean;
    noStream?: boolean;
  },
): Effect.Effect<void, Error, Dependencies> {
  return Effect.gen(function* () {
    // ... load agent ...

    // Start chat loop with streaming options
    yield* startChatLoop(agent, {
      forceStream: options.stream,
      forceNoStream: options.noStream,
    });
  });
}

// Update Commander.js command definition
program
  .command("chat")
  .argument("<agent-id>", "Agent identifier")
  .option("--stream", "Force streaming mode")
  .option("--no-stream", "Disable streaming mode")
  .description("Chat with an AI agent")
  .action((agentId, options) => {
    // ... existing setup ...
    runEffect(chatWithAIAgentCommand(agentId, options));
  });
```

#### 5.2 Configuration File Schema

```typescript
// Update config schema
export interface AppConfig {
  // ... existing fields ...

  /**
   * Output/display configuration for CLI and terminal rendering
   * These settings apply to both streaming and non-streaming modes
   */
  output?: {
    /**
     * Show reasoning/thinking process for models that support it
     * (e.g., OpenAI o1, Claude extended thinking, DeepSeek R1)
     * Applies to both streaming and non-streaming modes
     * Default: true
     */
    showThinking?: boolean;

    /**
     * Show visual indicators for tool execution
     * Applies to both streaming and non-streaming modes
     * Default: true
     */
    showToolExecution?: boolean;

    /**
     * Output format for terminal display
     * - "plain": Plain text
     * - "markdown": Formatted markdown (default)
     */
    format?: "plain" | "markdown";

    /**
     * Streaming-specific configuration
     */
    streaming?: {
      /**
       * Enable streaming mode
       * - true: Always stream
       * - false: Never stream
       * - "auto": Auto-detect based on TTY (default)
       */
      enabled?: boolean | "auto";

      /**
       * Enable progressive markdown rendering with formatting
       * Only applies when streaming is enabled
       * Default: true
       */
      progressiveMarkdown?: boolean;

      /**
       * Text buffer delay in milliseconds
       * Batches small chunks for smoother rendering
       * Only applies when streaming is enabled
       * Default: 50
       */
      textBufferMs?: number;
    };
  };
}

// Default display configuration (applies to both modes)
export const DEFAULT_DISPLAY_CONFIG = {
  showThinking: true,
  showToolExecution: true,
  format: "markdown" as const,
};

// Default streaming configuration (streaming-specific)
export const DEFAULT_STREAMING_CONFIG = {
  enabled: true, // Used internally after auto-detection
  progressiveMarkdown: true,
  textBufferMs: 50,
};

// Note: showMetrics is part of LoggingConfig, defaults to false
// Can be enabled via logging.showMetrics or automatically with logging.level = "debug"
```

---

### Phase 6: Error Handling & Edge Cases (Day 6)

#### 6.1 Graceful Degradation

```typescript
// Wrap streaming with fallback
function createChatCompletionWithFallback(
  service: LLMService,
  provider: string,
  options: ChatCompletionOptions,
): Effect.Effect<ChatCompletionResponse, LLMError> {
  return Effect.gen(function* () {
    if (options.streamingConfig?.enabled) {
      try {
        // Try streaming first
        const result = yield* service.createStreamingChatCompletion(provider, options);
        return yield* result.response;
      } catch (error) {
        // Fall back to non-streaming
        console.log(chalk.yellow("\n[Streaming failed, using standard mode]\n"));
        return yield* service.createChatCompletion(provider, options);
      }
    } else {
      // Use non-streaming directly
      return yield* service.createChatCompletion(provider, options);
    }
  });
}
```

#### 6.2 Interruption Handling

```typescript
// Handle Ctrl+C during streaming
export function setupStreamInterruption(): Effect.Effect<void, never> {
  return Effect.sync(() => {
    process.on("SIGINT", () => {
      console.log("\n\n[Streaming interrupted by user]\n");
      process.exit(0);
    });
  });
}
```

#### 6.3 Stream Timeout

```typescript
// Add timeout to streaming
const streamWithTimeout = Stream.timeout(
  streamingResult.stream,
  Duration.seconds(300), // 5 minute timeout
).pipe(
  Stream.catchAll((error) => {
    if (error._tag === "TimeoutException") {
      return Stream.make({
        type: "error",
        error: new LLMRequestError(provider, "Streaming timeout"),
        recoverable: false,
      });
    }
    return Stream.fail(error);
  }),
);
```

---

### Phase 7: Testing Strategy (Day 7)

#### 7.1 Unit Tests

```typescript
// services/llm/ai-sdk-service.test.ts

describe("Streaming Chat Completion", () => {
  it("should emit stream events in correct order", async () => {
    const events: StreamEvent[] = [];

    const result = await llmService.createStreamingChatCompletion("openai", testOptions);

    await Stream.runForEach(result.stream, (event) => {
      events.push(event);
      return Effect.succeed(undefined);
    });

    expect(events[0].type).toBe("stream_start");
    expect(events.some((e) => e.type === "text_chunk")).toBe(true);
    expect(events[events.length - 1].type).toBe("complete");
  });

  it("should accumulate text correctly", async () => {
    const result = await llmService.createStreamingChatCompletion("openai", testOptions);

    let accumulated = "";
    await Stream.runForEach(result.stream, (event) => {
      if (event.type === "text_chunk") {
        accumulated = event.accumulated;
      }
      return Effect.succeed(undefined);
    });

    const finalResponse = await result.response;
    expect(finalResponse.content).toBe(accumulated);
  });

  it("should handle errors gracefully", async () => {
    const result = await llmService.createStreamingChatCompletion("openai", invalidOptions);

    await expect(Stream.runCollect(result.stream)).rejects.toThrow(LLMAuthenticationError);
  });
});
```

#### 7.2 Integration Tests

```typescript
describe("Agent Runner with Streaming", () => {
  it("should stream responses in interactive mode", async () => {
    const mockTTY = jest.spyOn(process.stdout, "isTTY", "get");
    mockTTY.mockReturnValue(true);

    const response = await AgentRunner.run({
      agent: testAgent,
      userInput: "Hello",
    });

    expect(response.content).toBeTruthy();
    mockTTY.mockRestore();
  });

  it("should not stream in non-TTY mode", async () => {
    const mockTTY = jest.spyOn(process.stdout, "isTTY", "get");
    mockTTY.mockReturnValue(false);

    // Should use non-streaming path
    const response = await AgentRunner.run({
      agent: testAgent,
      userInput: "Hello",
    });

    expect(response.content).toBeTruthy();
    mockTTY.mockRestore();
  });
});
```

#### 7.3 Manual Testing Checklist

- [ ] Test with OpenAI GPT-4
- [ ] Test with Anthropic Claude
- [ ] Test with Google Gemini
- [ ] Test with reasoning models (o1, Claude thinking)
- [ ] Test tool calls during streaming
- [ ] Test Ctrl+C interruption
- [ ] Test in CI environment (should not stream)
- [ ] Test with piped output
- [ ] Test with `--no-stream` flag
- [ ] Test with `--stream` flag
- [ ] Test config file overrides
- [ ] Test error recovery
- [ ] Test network interruption

---

## Performance Optimizations

### 1. Text Buffering

```typescript
// Buffer small chunks to reduce terminal updates
class TextBuffer {
  private buffer: string = "";
  private timer: NodeJS.Timeout | null = null;

  add(chunk: string, flushMs: number = 50): void {
    this.buffer += chunk;

    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      this.flush();
    }, flushMs);
  }

  flush(): void {
    if (this.buffer.length > 0) {
      process.stdout.write(this.buffer);
      this.buffer = "";
    }
  }
}
```

### 2. Backpressure Handling

```typescript
// Use Stream.buffer to handle slow consumers
const bufferedStream = streamingResult.stream.pipe(
  Stream.buffer(100), // Buffer up to 100 events
  Stream.sliding(50), // Keep most recent 50 if overflowing
);
```

### 3. Resource Cleanup

```typescript
// Ensure cleanup on interruption
yield *
  Effect.acquireRelease(
    // Acquire stream
    llmService.createStreamingChatCompletion(provider, options),

    // Release resources
    (result) =>
      Effect.sync(() => {
        // Cancel any pending operations
        renderer.cleanup();
        MarkdownRenderer.reset();
      }),
  );
```

---

## Migration Path

### For Existing Code

**No changes required!** All existing code continues to work:

```typescript
// This code requires zero changes
const response = yield * llmService.createChatCompletion(provider, options);
console.log(response.content);
```

### For New Streaming Features

```typescript
// Opt-in to streaming
const result = yield * llmService.createStreamingChatCompletion(provider, options);

// Process stream
yield * Stream.runForEach(result.stream, handleEvent);

// Or just get final response
const response = yield * result.response;
```

---

## Configuration Examples

### ~/.jazz/config.json

```json
{
  "logging": {
    "level": "info",
    "format": "pretty",
    "showMetrics": false
  },
  "output": {
    "showThinking": true,
    "showToolExecution": true,
    "format": "markdown",
    "streaming": {
      "enabled": "auto",
      "progressiveMarkdown": true,
      "textBufferMs": 50
    }
  }
}
```

**All fields are optional - only include what you want to override:**

```json
{
  "output": {
    "streaming": {
      "enabled": false
    }
  }
}
```

```json
{
  "output": {
    "showThinking": false,
    "showToolExecution": false
  }
}
```

```json
{
  "logging": {
    "showMetrics": true
  },
  "output": {
    "format": "plain",
    "streaming": {
      "textBufferMs": 100
    }
  }
}
```

### Environment Variables

```bash
# Disable streaming globally
export JAZZ_NO_STREAM=1

# Enable in CI (usually auto-disabled)
export JAZZ_FORCE_STREAM=1
```

### CLI Flags

```bash
# Force streaming on
jazz chat my-agent --stream

# Force streaming off
jazz chat my-agent --no-stream

# Auto-detect (default)
jazz chat my-agent
```

---

## Success Metrics

### Technical Metrics

- [ ] Zero breaking changes to public APIs
- [ ] All existing tests pass
- [ ] <100ms overhead for streaming vs non-streaming
- [ ] <5% memory increase
- [ ] Proper cleanup on interruption (no leaks)

### UX Metrics

- [ ] First token appears in <500ms
- [ ] Smooth rendering (no stuttering)
- [ ] Clear visual indicators for thinking/tools
- [ ] Clean output when piped
- [ ] Graceful error messages

### Quality Metrics

- [ ] 100% type safety (no `any`)
- [ ] > 90% test coverage for new code
- [ ] Works with all providers
- [ ] Documented with examples
- [ ] Handles edge cases gracefully

---

## Risk Mitigation

| Risk                                | Mitigation                                                   |
| ----------------------------------- | ------------------------------------------------------------ |
| Streaming breaks existing workflows | Feature flag + auto-detection ensures backward compatibility |
| Performance regression              | Benchmarking + fallback to non-streaming if slow             |
| Provider incompatibility            | Try/catch with fallback to generateText                      |
| Memory leaks                        | Proper Effect.Stream cleanup + testing                       |
| CI/CD issues                        | Auto-disable in non-TTY environments                         |
| User confusion                      | Clear documentation + smart defaults                         |

---

## Future Enhancements

### Phase 2 (Post-MVP)

- [ ] Rich terminal UI with boxes and borders
- [ ] Syntax highlighting for streamed code blocks
- [ ] Real-time token counter display
- [ ] Progress bars for long operations
- [ ] Audio feedback for completion
- [ ] Copy-to-clipboard for responses
- [ ] Response quality ratings

### Phase 3 (Advanced)

- [ ] Web UI with streaming
- [ ] Multiple simultaneous streams
- [ ] Stream recording/replay
- [ ] Advanced markdown rendering (tables, etc.)
- [ ] Syntax highlighting with tree-sitter
- [ ] Image rendering in terminal (iTerm2, etc.)

---

## Dependencies

### New Dependencies

```json
{
  "chalk": "^5.3.0", // Terminal colors (may already exist)
  "cli-spinners": "^2.9.0", // Thinking indicators
  "cli-cursor": "^4.0.0" // Cursor control
}
```

### AI SDK APIs Used

- `streamText()` - Main streaming API
- `result.textStream` - Text chunks
- `result.experimental_thinkingStream` - Reasoning process
- `result.fullStream` - All events including tool calls
- `result.finished` - Completion promise

---

## Timeline

**Total: 7 days of focused development**

- **Day 1**: Type system, stream detection (8h)
- **Day 2**: AI SDK streaming implementation (8h)
- **Day 3**: Terminal renderer (8h)
- **Day 4**: Agent runner integration (8h)
- **Day 5**: CLI updates + config (6h)
- **Day 6**: Error handling + edge cases (8h)
- **Day 7**: Testing + polish (8h)

**Total effort: ~54 hours**

---

## Implementation Checklist

### Core Implementation

- [ ] Create streaming-types.ts with event types
- [ ] Update LLM service interface
- [ ] Implement stream detection utility
- [ ] Implement createStreamingChatCompletion in AI SDK service
- [ ] Create StreamRenderer class
- [ ] Update MarkdownRenderer for progressive rendering
- [ ] Update AgentRunner with streaming path
- [ ] Add CLI flags (--stream, --no-stream)
- [ ] Update config schema

### Error Handling

- [ ] Graceful degradation (fallback to non-streaming)
- [ ] Ctrl+C interruption handling
- [ ] Stream timeout handling
- [ ] Provider error conversion
- [ ] Network failure recovery

### Testing

- [ ] Unit tests for streaming events
- [ ] Integration tests for agent runner
- [ ] Manual tests with all providers
- [ ] CI/CD environment tests
- [ ] Performance benchmarks

### Documentation

- [ ] Update README with streaming info
- [ ] Add streaming examples
- [ ] Document configuration options
- [ ] Add troubleshooting guide
- [ ] Update API documentation

### Polish

- [ ] Clean up console output
- [ ] Add visual indicators
- [ ] Optimize buffering
- [ ] Resource cleanup
- [ ] Error messages

---

**Ready to implement? This design gives us:** ✅ Backward compatibility ✅ World-class UX ✅
Production-grade quality ✅ Smart defaults ✅ Full control ✅ Maintainable code

Let's build this! 🚀

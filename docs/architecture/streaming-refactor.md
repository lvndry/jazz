# Streaming Architecture Refactor

## Overview

This document describes the refactored streaming architecture for Jazz's AI agent system. The refactor addresses the complexity and maintainability issues in the original streaming implementation while improving reliability, error handling, and user experience.

## Problems with the Original Architecture

### 1. **Spaghetti Code**
- 500+ lines of complex streaming logic mixed in a single method
- Multiple nested promises and async operations running in parallel
- Difficult to understand control flow and completion signals
- Hard to debug and maintain

### 2. **Complex Completion Tracking**
- Multiple flags tracking completion state (`textStreamCompleted`, `reasoningTextCompleted`, `finishEventReceived`, `shouldStopFullStream`)
- Conditional logic spread across multiple locations
- Timeouts and grace periods scattered throughout
- Race conditions between different streams

### 3. **Mixed Concerns**
- AI SDK response handling mixed with Effect stream emission
- Stream lifecycle management intertwined with business logic
- Error handling scattered across multiple try-catch blocks

### 4. **Error-Prone**
- Silent error swallowing in multiple places
- Inconsistent error handling patterns
- Stream not properly closed in all scenarios
- Potential for hanging conversations

## New Architecture

### Core Principle: **Separation of Concerns**

The refactor separates streaming into clear, focused components:

```
┌─────────────────────────────────────────────────────────────┐
│                     ai-sdk-service.ts                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ createStreamingChatCompletion()                        │ │
│  │ • Sets up AI SDK streamText                            │ │
│  │ • Creates AbortController for cancellation             │ │
│  │ • Creates Effect Stream                                │ │
│  │ • Delegates processing to StreamProcessor              │ │
│  └─────────────────────┬──────────────────────────────────┘ │
└────────────────────────┼────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   stream-processor.ts                        │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ StreamProcessor                                        │ │
│  │ • Handles AI SDK StreamText responses                  │ │
│  │ • Manages completion signals                           │ │
│  │ • Emits Effect Stream events                           │ │
│  │ • Tracks reasoning and text streams                    │ │
│  │ • Builds final response                                │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    agent-runner.ts                           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Stream.runForEach()                                    │ │
│  │ • Consumes stream events                               │ │
│  │ • Updates UI via OutputRenderer                        │ │
│  │ • Handles tool execution                               │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

#### 1. **StreamProcessor** (`stream-processor.ts`)

A dedicated class that encapsulates all AI SDK streaming logic:

**Responsibilities:**
- Process AI SDK `StreamText` result
- Track stream completion state
- Emit Effect stream events
- Build final response with metrics
- Close stream properly

**Benefits:**
- Single responsibility: AI SDK → Effect Stream translation
- Testable in isolation
- Clear state management
- Predictable completion logic

**API:**
```typescript
class StreamProcessor {
  constructor(config: StreamProcessorConfig, emit: EmitFunction)
  
  async process(result: StreamTextResult): Promise<ChatCompletionResponse>
  close(): void
}
```

**Internal State Management:**
```typescript
interface StreamProcessorState {
  // Text tracking
  accumulatedText: string
  textSequence: number
  textStreamCompleted: boolean
  hasStartedText: boolean

  // Reasoning tracking (for o1, Claude, etc.)
  reasoningSequence: number
  reasoningStreamCompleted: boolean
  hasStartedReasoning: boolean
  thinkingCompleteEmitted: boolean
  reasoningTokens: number | undefined

  // Tool calls
  collectedToolCalls: ToolCall[]

  // Completion tracking
  finishEventReceived: boolean
  firstTokenTime: number | null
}
```

#### 2. **Simplified `ai-sdk-service.ts`**

The streaming method is now clean and focused:

```typescript
createStreamingChatCompletion(
  providerName: string,
  options: ChatCompletionOptions,
): Effect.Effect<StreamingResult, LLMError> {
  // 1. Setup: Create AI SDK stream
  const result = streamText({ ... })
  
  // 2. Process: Delegate to StreamProcessor
  const processor = new StreamProcessor(config, emit)
  const finalResponse = await processor.process(result)
  
  // 3. Cleanup: Close stream
  processor.close()
}
```

**Before:** 500+ lines of complex logic  
**After:** ~70 lines of clear, focused code

#### 3. **Stream Completion Logic**

**Simple and Predictable:**

```typescript
private checkCompletion(): void {
  if (hasReasoningEnabled) {
    // Reasoning models: wait for both text and reasoning
    if (textStreamCompleted && reasoningStreamCompleted) {
      resolveCompletion()
    }
  } else {
    // Non-reasoning models: wait for text only
    if (textStreamCompleted) {
      resolveCompletion()
    }
  }
}
```

**Completion Promise Pattern:**
- Single promise created at start
- Resolved when conditions met
- No timeouts, no race conditions
- Clean async/await flow

### Stream Processing Flow

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Start Processing                                          │
│    • Emit stream_start                                       │
│    • Launch parallel stream processors                       │
└────────────────────┬─────────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
┌──────────┐  ┌──────────┐  ┌───────────┐
│ Text     │  │ Reasoning│  │ Full      │
│ Stream   │  │ Text     │  │ Stream    │
└────┬─────┘  └────┬─────┘  └─────┬─────┘
     │             │              │
     │ text_chunk  │ thinking_*   │ tool_call
     │ text_start  │              │ finish
     │             │              │
     ▼             ▼              ▼
┌──────────────────────────────────────┐
│ Accumulate State                     │
│ • Text content                       │
│ • Reasoning content                  │
│ • Tool calls                         │
│ • Completion signals                 │
└────────────┬─────────────────────────┘
             │
             ▼ (all streams complete)
┌──────────────────────────────────────┐
│ Build Final Response                 │
│ • Combine all data                   │
│ • Fetch usage (with timeout)         │
│ • Calculate metrics                  │
└────────────┬─────────────────────────┘
             │
             ▼
┌──────────────────────────────────────┐
│ Emit Complete & Close                │
│ • Emit complete event                │
│ • Signal end of stream               │
└──────────────────────────────────────┘
```

## Benefits of New Architecture

### 1. **Maintainability** ✅
- Clear separation of concerns
- Each component has single responsibility
- Easy to understand and modify
- Self-documenting code structure

### 2. **Reliability** ✅
- Predictable completion logic
- Proper stream closure in all cases
- No silent error swallowing
- Graceful error handling

### 3. **Testability** ✅
- StreamProcessor can be unit tested
- Mock AI SDK responses easily
- Test completion logic in isolation
- Verify stream events independently

### 4. **User Experience** ✅
- Conversations no longer hang
- Consistent streaming behavior
- Better error messages
- Smooth UX for both streaming and non-streaming modes

### 5. **Performance** ✅
- Parallel stream processing
- Non-blocking completion
- Quick usage retrieval with timeout
- Efficient state management

## Migration Guide

### For Developers

**The public API hasn't changed!** The refactor is internal - all existing code continues to work:

```typescript
// Still works exactly the same
const streamingResult = await llmService.createStreamingChatCompletion(
  provider,
  options
)

// Still process events the same way
await Stream.runForEach(streamingResult.stream, (event) => {
  // Handle events
})
```

### For Future Development

**Adding New Stream Events:**

1. Add event type to `StreamEvent` in `streaming-types.ts`
2. Emit event in appropriate `StreamProcessor` method
3. Handle event in `agent-runner.ts` or `output-renderer.ts`

**Example:**
```typescript
// 1. Add to streaming-types.ts
export type StreamEvent = 
  | ... // existing events
  | { type: "custom_event"; data: string }

// 2. Emit in stream-processor.ts
this.emitEvent({ type: "custom_event", data: "value" })

// 3. Handle in agent-runner.ts
if (event.type === "custom_event") {
  // Process custom event
}
```

## Error Handling Strategy

### Graceful Degradation

The new architecture follows a **graceful degradation** pattern:

```
┌──────────────────────────────────────────────┐
│ Critical Path: Text Content                  │
│ • Must succeed for completion                │
│ • Errors block stream completion             │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Optional Path: Reasoning Content             │
│ • Errors logged but don't block completion   │
│ • Continues with text-only response          │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ Optional Path: Usage/Metrics                 │
│ • Timeout after 50ms if not available        │
│ • Response includes metrics if available     │
│ • Otherwise continues without metrics        │
└──────────────────────────────────────────────┘
```

### Error Recovery

- **Stream errors:** Close stream, emit error event, reject promise
- **Reasoning errors:** Log, mark complete, continue with text
- **Usage errors:** Log, continue without usage data
- **Tool errors:** Record, emit error event, continue agent loop

## Performance Considerations

### Parallel Processing

All streams process in parallel for optimal performance:

```typescript
await Promise.all([
  this.processTextStream(result),      // Text content
  this.processReasoningText(result),   // Reasoning (if enabled)
  this.processFullStream(result),      // Tool calls & metadata
])
```

### Non-Blocking Completion

- Usage fetched with 50ms timeout
- Metrics calculated if available
- Stream completes immediately after text/reasoning

### Resource Management

- AbortController cancels AI SDK requests
- Streams close properly
- No memory leaks
- Clean async promise chains

## Testing Strategy

### Unit Tests (Recommended)

```typescript
describe("StreamProcessor", () => {
  it("emits events in correct order", async () => {
    const events: StreamEvent[] = []
    const emit = (e) => events.push(e)
    
    const processor = new StreamProcessor(config, emit)
    await processor.process(mockStreamTextResult)
    
    expect(events[0].type).toBe("stream_start")
    expect(events[events.length - 1].type).toBe("complete")
  })
  
  it("handles reasoning models correctly", async () => {
    // Test reasoning-specific logic
  })
  
  it("closes stream on error", async () => {
    // Test error handling
  })
})
```

### Integration Tests

```typescript
describe("Streaming Integration", () => {
  it("completes conversation without hanging", async () => {
    const response = await AgentRunner.run(options)
    expect(response.content).toBeDefined()
  })
  
  it("handles tool calls correctly", async () => {
    // Test tool execution during streaming
  })
})
```

## Future Improvements

### Potential Enhancements

1. **Streaming Metrics Dashboard**
   - Real-time token usage tracking
   - Latency monitoring
   - Error rate tracking

2. **Adaptive Streaming**
   - Auto-adjust buffer size based on network speed
   - Dynamic timeouts based on model
   - Intelligent retry strategies

3. **Enhanced Debugging**
   - Stream event logging
   - Performance profiling
   - Completion signal tracing

4. **Provider-Specific Optimizations**
   - Leverage provider-specific metadata
   - Custom event handlers per provider
   - Provider capability detection

## Conclusion

The streaming refactor transforms complex, error-prone spaghetti code into a clean, maintainable, and reliable architecture. The new design:

- **Separates concerns** clearly between components
- **Simplifies completion logic** with predictable patterns
- **Improves error handling** with graceful degradation
- **Enhances user experience** with reliable streaming
- **Enables future development** with testable, extensible code

The refactor maintains full backward compatibility while providing a solid foundation for future enhancements.

## References

- [AI SDK Documentation](https://ai-sdk.dev/docs)
- [Effect Documentation](https://effect.website/docs)
- [Stream Processing Best Practices](https://effect.website/docs/guides/streaming)
- [Jazz Architecture Guide](/docs/architecture/overview.md)

---

**Last Updated:** November 17, 2025  
**Author:** Jazz Development Team  
**Version:** 1.0.0


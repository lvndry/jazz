# Streaming Implementation Plan for Jazz

## Executive Summary

This document analyzes different approaches to implement streaming LLM responses in Jazz, replacing
the current "wait-for-complete-generation" behavior with real-time streaming to the terminal.

**Impact Level:** 🔴 **HIGH** - This is a significant architectural change affecting multiple
layers.

---

## Current Architecture Analysis

### Current Flow

```
User Input → AgentRunner.run() → LLMService.createChatCompletion()
  → generateText() [AI SDK] → Wait for complete response
  → Return full response → Display to terminal
```

### Key Components Affected

1. **`src/services/llm/ai-sdk-service.ts`** - Lines 352-367: Uses `generateText()`
2. **`src/services/llm/types.ts`** - Type definitions for responses
3. **`src/core/agent/agent-runner.ts`** - Lines 226-248: Consumes LLM responses
4. **`src/cli/commands/chat-agent.ts`** - Lines 592-606: Displays responses
5. **`src/core/utils/markdown-renderer.ts`** - Response formatting

### Current Type Contracts

```typescript
interface ChatCompletionResponse {
  id: string;
  model: string;
  content: string; // ← Complete content
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}
```

---

## Implementation Approaches

## 📋 Approach 1: Callback-Based Streaming (RECOMMENDED)

### Overview

Add an optional `onChunk` callback to handle streaming while maintaining backward compatibility.

### Architecture

```typescript
interface StreamingCallbacks {
  onTextChunk?: (chunk: string) => void | Promise<void>;
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
  onComplete?: (response: ChatCompletionResponse) => void | Promise<void>;
}

interface ChatCompletionOptions {
  // ... existing fields
  stream?: boolean;
  streamingCallbacks?: StreamingCallbacks;
}
```

### Pros

✅ **Backward Compatible**: Non-streaming code continues to work unchanged  
✅ **Clean Separation**: Streaming logic is opt-in via callbacks  
✅ **Type Safe**: Full TypeScript support with clear contracts  
✅ **Flexible**: Can add more events (tool calls, usage updates, etc.)  
✅ **Effect-TS Friendly**: Works well with Effect's async model  
✅ **Testable**: Easy to mock callbacks in tests

### Cons

❌ **Callback Hell Risk**: Multiple nested callbacks could get messy  
❌ **Error Handling**: Need to handle errors in both callback and return path  
❌ **State Management**: Need to accumulate chunks for final response

### Implementation Complexity: **Medium** (2-3 days)

### Key Changes

1. **LLM Service** (~100 lines)
   - Replace `generateText` with `streamText` when `stream: true`
   - Accumulate chunks and call `onTextChunk` callback
   - Build final response for return value

2. **Agent Runner** (~50 lines)
   - Pass streaming callbacks to LLM service
   - Handle real-time display of chunks
   - Maintain existing tool execution flow

3. **CLI Commands** (~30 lines)
   - Implement callbacks to write chunks to terminal
   - Use `process.stdout.write()` for streaming display

### Code Example

```typescript
// ai-sdk-service.ts
const result = await streamText({
  model,
  messages: toCoreMessages(options.messages),
  tools,
});

let accumulatedText = "";
for await (const chunk of result.textStream) {
  accumulatedText += chunk;
  await options.streamingCallbacks?.onTextChunk?.(chunk);
}

return {
  content: accumulatedText,
  toolCalls: result.toolCalls,
  usage: result.usage,
};
```

---

## 📋 Approach 2: AsyncIterable Streaming

### Overview

Return an async iterable from the LLM service that yields chunks.

### Architecture

```typescript
type ChatCompletionResult =
  | { type: "complete"; response: ChatCompletionResponse }
  | { type: "streaming"; stream: AsyncIterable<StreamChunk> };

interface StreamChunk {
  type: "text" | "tool_call" | "complete";
  content?: string;
  toolCall?: ToolCall;
  finalResponse?: ChatCompletionResponse;
}
```

### Pros

✅ **Functional Style**: Aligns with functional programming principles  
✅ **Composable**: Easy to pipe, map, filter streaming data  
✅ **Effect-TS Stream**: Could use `Stream.fromAsyncIterable`  
✅ **Clear Flow**: Data flow is explicit and linear

### Cons

❌ **Breaking Change**: All consumers must handle streaming  
❌ **Complex Type System**: Discriminated unions everywhere  
❌ **Effect Integration**: Need to bridge async iterables with Effect  
❌ **Testing Complexity**: Harder to test async iterables  
❌ **Backward Incompatible**: Requires rewriting all call sites

### Implementation Complexity: **High** (4-5 days)

---

## 📋 Approach 3: Dual Method Pattern

### Overview

Create separate methods for streaming vs non-streaming.

### Architecture

```typescript
interface LLMService {
  createChatCompletion(options): Effect<ChatCompletionResponse, Error>;

  // New streaming method
  streamChatCompletion(
    options,
    callbacks: StreamingCallbacks,
  ): Effect<ChatCompletionResponse, Error>;
}
```

### Pros

✅ **Explicit Intent**: Clear separation between streaming and non-streaming  
✅ **No Breaking Changes**: Existing code untouched  
✅ **Simple Migration**: Gradually migrate to streaming where needed  
✅ **Easy to Test**: Test each method independently

### Cons

❌ **Code Duplication**: Similar logic in two places  
❌ **Maintenance Burden**: Need to keep both methods in sync  
❌ **API Surface Growth**: More methods to document and maintain  
❌ **Feature Divergence Risk**: Methods could drift apart over time

### Implementation Complexity: **Medium** (3-4 days)

---

## 📋 Approach 4: Effect.Stream-Based

### Overview

Use Effect-TS's built-in `Stream` for streaming responses.

### Architecture

```typescript
function streamChatCompletion(
  options: ChatCompletionOptions,
): Effect<Stream.Stream<StreamChunk, LLMError>, never, LLMService> {
  // Returns Effect that produces a Stream
}
```

### Pros

✅ **Effect-Native**: Perfect integration with Effect ecosystem  
✅ **Powerful Combinators**: Built-in operators for stream manipulation  
✅ **Resource Safety**: Automatic cleanup and finalization  
✅ **Composable**: Easily combine multiple streams  
✅ **Type Safe**: Full Effect type checking

### Cons

❌ **Learning Curve**: Team needs deep Effect-TS knowledge  
❌ **Breaking Change**: Major API redesign required  
❌ **Complexity**: Effect.Stream adds conceptual overhead  
❌ **Migration Cost**: All consumers need updates  
❌ **Debugging**: Harder to debug stream pipelines

### Implementation Complexity: **Very High** (5-7 days)

---

## Detailed Recommendation: Approach 1 (Callback-Based)

### Why This Approach Wins

1. **Backward Compatibility**: Existing code continues to work without changes
2. **Incremental Migration**: Can enable streaming per-command basis
3. **Simple Mental Model**: Callbacks are familiar to all developers
4. **Quick Implementation**: Can ship in 2-3 days
5. **Low Risk**: Failures fall back to non-streaming behavior

### Implementation Phases

#### Phase 1: Type System Updates (Day 1, Morning)

```typescript
// types.ts - Add streaming types
export interface StreamingCallbacks {
  onTextChunk?: (chunk: string) => void | Promise<void>;
  onToolCallDetected?: (toolCall: ToolCall) => void | Promise<void>;
  onUsageUpdate?: (usage: TokenUsage) => void | Promise<void>;
}

export interface ChatCompletionOptions {
  // ... existing fields
  stream?: boolean;
  streamingCallbacks?: StreamingCallbacks;
}
```

#### Phase 2: AI SDK Service Update (Day 1, Afternoon)

```typescript
// ai-sdk-service.ts - Update createChatCompletion
async () => {
  // Determine if streaming is requested
  const shouldStream = options.stream === true && options.streamingCallbacks;

  if (shouldStream) {
    // Use streamText from AI SDK
    const result = await streamText({
      model,
      messages: toCoreMessages(options.messages),
      temperature: options.temperature,
      tools,
      providerOptions,
    });

    let accumulatedText = "";

    // Stream text chunks
    for await (const chunk of result.textStream) {
      accumulatedText += chunk;

      // Call callback for each chunk
      try {
        await options.streamingCallbacks?.onTextChunk?.(chunk);
      } catch (error) {
        // Log but don't fail - streaming is best-effort
        console.error("Error in streaming callback:", error);
      }
    }

    // Wait for completion to get tool calls and usage
    await result.finished;

    // Build final response
    return {
      id: "",
      model: options.model,
      content: accumulatedText,
      toolCalls: result.toolCalls,
      usage: result.usage,
    };
  } else {
    // Existing non-streaming path
    const result = await generateText({
      /* ... */
    });
    return {
      /* ... */
    };
  }
};
```

#### Phase 3: Agent Runner Update (Day 2, Morning)

```typescript
// agent-runner.ts - Add streaming support
const llmOptions = {
  model,
  messages: messagesToSend,
  tools,
  toolChoice: "auto" as const,
  reasoning_effort: agent.config.reasoningEffort ?? "disable",
  stream: true, // Enable streaming
  streamingCallbacks: {
    onTextChunk: (chunk: string) => {
      // Write directly to terminal without newline
      process.stdout.write(chunk);
    },
  },
};

const result = yield * llmService.createChatCompletion(provider, llmOptions);
// At this point, all text has been streamed
// Now handle tool calls if any
```

#### Phase 4: CLI Display Update (Day 2, Afternoon)

```typescript
// chat-agent.ts - Update chat loop
console.log(`\n${agent.name}:`);
// Streaming happens during AgentRunner.run()
const response = yield * AgentRunner.run(options);
console.log("\n"); // Add final newline after streaming
```

#### Phase 5: Testing & Polish (Day 3)

- Test with all providers (OpenAI, Anthropic, Google, etc.)
- Test tool calls during streaming
- Test error scenarios (network interruption, rate limits)
- Add configuration option to enable/disable streaming
- Update documentation

### Configuration

Add to agent config:

```typescript
interface AgentConfig {
  // ... existing fields
  streaming?: {
    enabled: boolean;
    bufferSize?: number; // Optional: batch small chunks
  };
}
```

Add to app config:

```typescript
interface AppConfig {
  // ... existing fields
  ui?: {
    streamingEnabled?: boolean; // Global default
  };
}
```

### Error Handling Strategy

```typescript
// Graceful degradation
try {
  // Attempt streaming
  await streamWithCallbacks(options);
} catch (error) {
  // Fall back to non-streaming
  console.log("\n[Streaming failed, switching to standard mode]\n");
  return await generateText(options);
}
```

### Testing Strategy

1. **Unit Tests**

   ```typescript
   test("streams text chunks via callback", async () => {
     const chunks: string[] = [];
     const result = await llmService.createChatCompletion({
       stream: true,
       streamingCallbacks: {
         onTextChunk: (chunk) => chunks.push(chunk),
       },
     });

     expect(chunks.length).toBeGreaterThan(0);
     expect(chunks.join("")).toBe(result.content);
   });
   ```

2. **Integration Tests**
   - Test with real LLM providers in CI (using test API keys)
   - Mock streaming responses for fast tests
   - Test error recovery and fallback

3. **Manual Testing**
   - Test with different models (GPT-4, Claude, Gemini)
   - Test with tool calls
   - Test with reasoning models
   - Test network interruptions

---

## Alternative: Hybrid Approach (Approach 1 + 3)

Combine callback-based streaming with a dedicated streaming method:

```typescript
interface LLMService {
  // Existing - no changes
  createChatCompletion(options): Effect<ChatCompletionResponse, Error>;

  // New - explicit streaming
  createStreamingChatCompletion(
    options,
    callbacks: StreamingCallbacks,
  ): Effect<ChatCompletionResponse, Error>;
}
```

**Benefits:**

- Explicit opt-in to streaming
- No accidental streaming
- Clear API surface
- Easy to A/B test

**Costs:**

- Slightly more code duplication
- Need to maintain both paths

---

## Migration Path for Consumers

### Before (Non-Streaming)

```typescript
const result =
  yield *
  llmService.createChatCompletion(provider, {
    model,
    messages,
    tools,
  });
console.log(result.content);
```

### After (With Streaming)

```typescript
const result =
  yield *
  llmService.createChatCompletion(provider, {
    model,
    messages,
    tools,
    stream: true,
    streamingCallbacks: {
      onTextChunk: (chunk) => process.stdout.write(chunk),
    },
  });
// result.content still has full text
```

### After (Hybrid - Explicit Streaming)

```typescript
const result =
  yield *
  llmService.createStreamingChatCompletion(
    provider,
    { model, messages, tools },
    {
      onTextChunk: (chunk) => process.stdout.write(chunk),
    },
  );
```

---

## Performance Considerations

### Latency Improvements

- **First token latency**: ~100-500ms (vs 5-30s for complete response)
- **Perceived performance**: Feels instant to users
- **User engagement**: Users see progress immediately

### Resource Usage

- **Memory**: Slightly higher (need to accumulate chunks)
- **CPU**: Minimal overhead (just callback execution)
- **Network**: Same (streaming is server-side decision)

### Benchmarks (Expected)

```
Non-streaming (500 token response):
  Time to first content: 5-10 seconds
  Time to complete: 5-10 seconds
  User wait time: 5-10 seconds

Streaming (500 token response):
  Time to first token: 100-500ms
  Time to complete: 5-10 seconds
  User wait time: 0.5-1 second (perceived)
```

---

## Risk Assessment

| Risk                     | Severity  | Mitigation                                 |
| ------------------------ | --------- | ------------------------------------------ |
| Breaking existing code   | 🟢 Low    | Approach 1 is backward compatible          |
| Streaming failures       | 🟡 Medium | Graceful fallback to non-streaming         |
| Provider incompatibility | 🟡 Medium | Test all providers; disable if unsupported |
| Performance regression   | 🟢 Low    | Streaming improves perceived performance   |
| Complexity increase      | 🟡 Medium | Clear documentation and examples           |
| Testing burden           | 🟡 Medium | Focus on integration tests with mocks      |

---

## Recommended Decision Matrix

| Approach         | Complexity | Breaking Changes | Time to Ship      | Future-Proof | Score        |
| ---------------- | ---------- | ---------------- | ----------------- | ------------ | ------------ |
| **1. Callbacks** | ⭐⭐⭐     | ✅ None          | ⭐⭐⭐⭐⭐ (2-3d) | ⭐⭐⭐⭐     | **🏆 15/20** |
| 2. AsyncIterable | ⭐⭐       | ❌ Major         | ⭐⭐ (4-5d)       | ⭐⭐⭐⭐     | 12/20        |
| 3. Dual Method   | ⭐⭐⭐     | ✅ None          | ⭐⭐⭐ (3-4d)     | ⭐⭐⭐       | 14/20        |
| 4. Effect.Stream | ⭐         | ❌ Major         | ⭐ (5-7d)         | ⭐⭐⭐⭐⭐   | 11/20        |
| Hybrid (1+3)     | ⭐⭐       | ✅ None          | ⭐⭐⭐ (3-4d)     | ⭐⭐⭐⭐⭐   | **🏆 16/20** |

---

## Final Recommendation

### 🎯 Implement **Hybrid Approach (Callback + Dedicated Method)**

**Rationale:**

1. **Zero breaking changes** - existing code continues working
2. **Explicit intent** - `createStreamingChatCompletion` makes streaming obvious
3. **Quick to ship** - 3-4 days of focused work
4. **Future-proof** - Can migrate to Effect.Stream later without API changes
5. **Best UX** - Immediate visual feedback improves perceived performance by 10x

**Implementation Plan:**

- Day 1: Type system + dedicated streaming method
- Day 2: Agent runner integration + CLI updates
- Day 3: Testing across all providers + documentation
- Day 4: Polish, edge cases, and release

**Success Metrics:**

- ✅ All existing tests pass without modification
- ✅ Streaming works with all configured LLM providers
- ✅ Perceived latency reduces from 5-10s to <1s
- ✅ Zero production incidents related to streaming

---

## Questions for Stakeholder

1. **Breaking changes tolerance**: Can we accept breaking changes for better architecture?
   - If YES → Consider Approach 4 (Effect.Stream) for long-term benefits
   - If NO → Stick with Hybrid Approach

2. **Timeline urgency**: How quickly do we need streaming?
   - If URGENT → Approach 1 (Callbacks only)
   - If FLEXIBLE → Hybrid Approach

3. **Future plans**: Do we plan to use Effect.Stream elsewhere in the codebase?
   - If YES → Consider Approach 4 for consistency
   - If NO → Hybrid Approach is sufficient

4. **Feature scope**: Do we need streaming only for chat, or also for agent runs?
   - Chat only → Simpler implementation
   - All agent execution → More comprehensive changes needed

---

## Appendix: AI SDK Streaming API Reference

The Vercel AI SDK provides excellent streaming support:

```typescript
import { streamText } from "ai";

const result = await streamText({
  model,
  messages,
  tools,
});

// Text streaming
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

// Full stream (includes tool calls)
for await (const part of result.fullStream) {
  switch (part.type) {
    case "text-delta":
      process.stdout.write(part.textDelta);
      break;
    case "tool-call":
      console.log("Tool call:", part.toolName);
      break;
  }
}

// Wait for completion
await result.finished;
console.log("Usage:", result.usage);
console.log("Tool calls:", result.toolCalls);
```

This API gives us everything we need for robust streaming support.

---

**Document Version**: 1.0  
**Last Updated**: 2025-11-15  
**Author**: Jazz AI Assistant

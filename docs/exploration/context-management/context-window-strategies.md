# Context Window Management Strategies

## Overview

As agent conversations grow longer, context windows fill up with message history, tool calls, and
outputs. Effective context management is crucial for:

- **Performance**: Keeping responses fast
- **Cost**: Reducing token usage
- **Quality**: Maintaining relevant context without noise
- **Scalability**: Supporting long-running conversations

This document explores strategies beyond simple summarization for managing context windows
intelligently.

## The Context Window Problem

### Typical Context Breakdown

```typescript
// After 10 agent iterations
const contextWindow = {
  systemPrompt: 2000, // Agent instructions
  conversationHistory: 15000, // Messages back-and-forth
  toolCalls: 8000, // Tool invocations
  toolResults: 12000, // Tool outputs
  totalTokens: 37000, // Approaching limits!
};

// Problems:
// - Most old messages irrelevant to current task
// - Tool results contain verbose output
// - Repeated information (asking same thing multiple times)
// - Context limit approaching (e.g., 128k tokens)
```

### What Happens Without Management

1. **Context Overflow**: Hit token limits, conversation breaks
2. **Performance Degradation**: Slower responses as context grows
3. **Cost Explosion**: Paying for irrelevant tokens
4. **Quality Issues**: Agent confused by too much context
5. **Lost Focus**: Important details buried in noise

## Strategy 1: Sliding Window (Keep Recent Only)

**Concept**: Keep only the N most recent messages, discard everything older.

```typescript
interface SlidingWindowConfig {
  readonly maxMessages: number;
  readonly keepSystemPrompt: boolean;
  readonly keepToolResults: boolean;
}

function applySlidingWindow(messages: ChatMessage[], config: SlidingWindowConfig): ChatMessage[] {
  // Always keep system prompt
  const systemMessages = messages.filter((m) => m.role === "system");

  // Get recent messages
  const otherMessages = messages.filter((m) => m.role !== "system");
  const recentMessages = otherMessages.slice(-config.maxMessages);

  return [...systemMessages, ...recentMessages];
}

// Usage
const compressed = applySlidingWindow(messages, {
  maxMessages: 20, // Keep last 20 messages
  keepSystemPrompt: true,
  keepToolResults: true,
});
```

**Pros**:

- ✅ Simple and predictable
- ✅ Fast (no LLM calls)
- ✅ Works well for short-term context

**Cons**:

- ❌ Loses all old information
- ❌ Can't reference earlier conversation
- ❌ Breaks long-running tasks

**Best For**: Short, focused tasks where history doesn't matter

## Strategy 2: Smart Summarization (LLM-Based)

**Concept**: Use LLM to create concise summaries of conversation segments.

```typescript
interface SummarizerConfig {
  readonly chunkSize: number; // Messages per chunk
  readonly summaryStyle: "brief" | "detailed" | "factual";
  readonly preserveToolCalls: boolean;
}

async function summarizeConversation(
  messages: ChatMessage[],
  config: SummarizerConfig,
): Promise<ChatMessage[]> {
  return Effect.gen(function* () {
    const llm = yield* LLMServiceTag;

    // Split into chunks
    const chunks = chunkMessages(messages, config.chunkSize);
    const summaries: ChatMessage[] = [];

    for (const chunk of chunks) {
      // Summarize this chunk
      const prompt = buildSummaryPrompt(chunk, config.summaryStyle);

      const summary = yield* llm.chat({
        messages: [{ role: "user", content: prompt }],
        model: "gpt-4o-mini", // Fast, cheap for summarization
      });

      summaries.push({
        role: "system",
        content: `[Summary]: ${summary.content}`,
      });
    }

    // Keep recent messages unsummarized
    const recent = messages.slice(-10);

    return [...summaries, ...recent];
  });
}

function buildSummaryPrompt(
  messages: ChatMessage[],
  style: "brief" | "detailed" | "factual",
): string {
  const conversation = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

  const styleInstructions = {
    brief: "Create a very brief summary (2-3 sentences)",
    detailed: "Create a detailed summary preserving key points",
    factual: "Extract only concrete facts, decisions, and actions taken",
  };

  return `Summarize this conversation segment. ${styleInstructions[style]}

${conversation}

Focus on:
- Decisions made
- Actions taken
- Important context for future reference
- User preferences expressed

Omit:
- Casual conversation
- Repeated information
- Failed attempts`;
}
```

**Pros**:

- ✅ Intelligent compression
- ✅ Preserves important information
- ✅ Flexible summarization styles

**Cons**:

- ❌ Additional LLM cost
- ❌ Latency (summarization takes time)
- ❌ Risk of losing important details

**Best For**: Long conversations where history matters

## Strategy 3: Importance-Based Filtering

**Concept**: Score messages by importance, keep only high-value content.

```typescript
interface ImportanceScorer {
  scoreMessage(message: ChatMessage, context: ConversationContext): number;
}

class MLImportanceScorer implements ImportanceScorer {
  scoreMessage(message: ChatMessage, context: ConversationContext): number {
    let score = 0;

    // User messages are important
    if (message.role === "user") score += 5;

    // Recent messages are important
    const recency = calculateRecency(message, context);
    score += recency * 3;

    // Messages with decisions/actions are important
    if (containsDecision(message.content)) score += 4;
    if (containsAction(message.content)) score += 3;

    // Tool calls that succeeded are important
    if (message.role === "tool" && !message.content.includes("error")) {
      score += 2;
    }

    // Long messages might be noise
    if (message.content.length > 5000) score -= 2;

    // Messages mentioning important entities
    if (mentionsImportantEntity(message, context.importantEntities)) {
      score += 3;
    }

    return score;
  }
}

function filterByImportance(
  messages: ChatMessage[],
  maxTokens: number,
  scorer: ImportanceScorer,
): ChatMessage[] {
  // Score all messages
  const scored = messages.map((msg) => ({
    message: msg,
    score: scorer.scoreMessage(msg, context),
    tokens: estimateTokens(msg.content),
  }));

  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score);

  // Keep highest-scoring messages within token budget
  const kept: typeof scored = [];
  let tokenCount = 0;

  for (const item of scored) {
    if (tokenCount + item.tokens <= maxTokens) {
      kept.push(item);
      tokenCount += item.tokens;
    }
  }

  // Re-sort by original order
  kept.sort((a, b) => messages.indexOf(a.message) - messages.indexOf(b.message));

  return kept.map((item) => item.message);
}

function containsDecision(content: string): boolean {
  const decisionPatterns = [
    /decided to/i,
    /will (use|implement|deploy)/i,
    /chosen/i,
    /selected/i,
    /approved/i,
  ];
  return decisionPatterns.some((pattern) => pattern.test(content));
}

function containsAction(content: string): boolean {
  const actionPatterns = [
    /executed/i,
    /deployed/i,
    /created/i,
    /updated/i,
    /deleted/i,
    /committed/i,
  ];
  return actionPatterns.some((pattern) => pattern.test(content));
}
```

**Pros**:

- ✅ Intelligent filtering
- ✅ No LLM cost for scoring
- ✅ Preserves most valuable content

**Cons**:

- ⚠️ Scoring heuristics may miss nuances
- ⚠️ Requires tuning
- ❌ Loses chronological context

**Best For**: Conversations with mixed importance content

## Strategy 4: Hierarchical Summarization

**Concept**: Create multi-level summaries, load detailed versions as needed.

```typescript
interface HierarchicalSummary {
  readonly level1: string; // Ultra-brief (1-2 sentences)
  readonly level2: string; // Brief (1 paragraph)
  readonly level3: string; // Detailed (multiple paragraphs)
  readonly originalMessages: ChatMessage[];
}

class HierarchicalSummarizer {
  async createHierarchy(
    messages: ChatMessage[],
  ): Effect.Effect<HierarchicalSummary, Error, LLMService> {
    return Effect.gen(function* () {
      const llm = yield* LLMServiceTag;
      const conversation = formatMessages(messages);

      // Level 1: Ultra-brief
      const level1 = yield* llm.chat({
        messages: [
          {
            role: "user",
            content: `Summarize in 1-2 sentences:\n\n${conversation}`,
          },
        ],
        model: "gpt-4o-mini",
      });

      // Level 2: Brief
      const level2 = yield* llm.chat({
        messages: [
          {
            role: "user",
            content: `Summarize in 1 paragraph, preserving key details:\n\n${conversation}`,
          },
        ],
        model: "gpt-4o-mini",
      });

      // Level 3: Detailed
      const level3 = yield* llm.chat({
        messages: [
          {
            role: "user",
            content: `Create detailed summary with all important information:\n\n${conversation}`,
          },
        ],
        model: "gpt-4o-mini",
      });

      return {
        level1: level1.content,
        level2: level2.content,
        level3: level3.content,
        originalMessages: messages,
      };
    });
  }
}

// Usage in agent
function buildContextWithHierarchy(
  recentMessages: ChatMessage[],
  hierarchies: HierarchicalSummary[],
  tokenBudget: number,
): ChatMessage[] {
  let tokens = estimateTokens(recentMessages);
  const context: ChatMessage[] = [...recentMessages];

  // Add historical context, starting with most detailed that fits
  for (const hierarchy of hierarchies) {
    if (tokens + estimateTokens(hierarchy.level1) < tokenBudget) {
      if (tokens + estimateTokens(hierarchy.level3) < tokenBudget) {
        // Fits detailed summary
        context.unshift({
          role: "system",
          content: `[Previous conversation]: ${hierarchy.level3}`,
        });
        tokens += estimateTokens(hierarchy.level3);
      } else if (tokens + estimateTokens(hierarchy.level2) < tokenBudget) {
        // Fits brief summary
        context.unshift({
          role: "system",
          content: `[Previous conversation]: ${hierarchy.level2}`,
        });
        tokens += estimateTokens(hierarchy.level2);
      } else {
        // Only ultra-brief fits
        context.unshift({
          role: "system",
          content: `[Previous conversation]: ${hierarchy.level1}`,
        });
        tokens += estimateTokens(hierarchy.level1);
      }
    }
  }

  return context;
}
```

**Pros**:

- ✅ Adaptive detail level based on budget
- ✅ Can drill down to original if needed
- ✅ Preserves hierarchical context

**Cons**:

- ❌ Multiple LLM calls (expensive)
- ❌ Storage overhead
- ⚠️ Complex to implement

**Best For**: Very long conversations needing historical reference

## Strategy 5: Semantic Relevance Filtering

**Concept**: Use embeddings to keep only contextually relevant messages.

```typescript
class SemanticContextManager {
  constructor(private readonly vectorMemory: VectorMemoryService) {}

  async filterByRelevance(
    messages: ChatMessage[],
    currentQuery: string,
    maxMessages: number,
  ): Effect.Effect<ChatMessage[], Error, LLMService> {
    return Effect.gen(
      function* (this: SemanticContextManager) {
        const llm = yield* LLMServiceTag;

        // Get embedding for current query
        const queryEmbedding = yield* llm.createEmbedding({
          input: currentQuery,
          model: "text-embedding-3-small",
        });

        // Score messages by similarity to current query
        const scored = await Promise.all(
          messages.map(async (msg) => {
            const msgEmbedding = await llm.createEmbedding({
              input: msg.content,
              model: "text-embedding-3-small",
            });

            const similarity = cosineSimilarity(queryEmbedding, msgEmbedding);

            return { message: msg, similarity };
          }),
        );

        // Keep most relevant messages
        scored.sort((a, b) => b.similarity - a.similarity);
        const relevant = scored.slice(0, maxMessages);

        // Re-sort by original order
        relevant.sort((a, b) => messages.indexOf(a.message) - messages.indexOf(b.message));

        return relevant.map((item) => item.message);
      }.bind(this),
    );
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}
```

**Pros**:

- ✅ Keeps semantically relevant context
- ✅ Good for topic changes
- ✅ Handles non-linear conversations

**Cons**:

- ❌ Embedding API costs
- ❌ Latency for embeddings
- ❌ Loses temporal ordering

**Best For**: Conversations with multiple topics or context switches

## Strategy 6: Tool Call Compression

**Concept**: Compress verbose tool outputs while preserving key information.

```typescript
interface ToolCallCompressor {
  compress(toolCall: ToolCallMessage, result: ToolResultMessage): ToolResultMessage;
}

class SmartToolCompressor implements ToolCallCompressor {
  compress(toolCall: ToolCallMessage, result: ToolResultMessage): ToolResultMessage {
    const resultContent = result.content;
    const resultLength = resultContent.length;

    // Small results - keep as is
    if (resultLength < 1000) {
      return result;
    }

    // Different compression strategies by tool type
    if (toolCall.name === "read_file") {
      return this.compressFileRead(result);
    } else if (toolCall.name === "execute_command") {
      return this.compressCommandOutput(result);
    } else if (toolCall.name === "list_dir") {
      return this.compressDirectoryList(result);
    } else if (toolCall.name === "git_log") {
      return this.compressGitLog(result);
    }

    // Default: truncate with summary
    return this.defaultCompress(result, resultLength);
  }

  private compressFileRead(result: ToolResultMessage): ToolResultMessage {
    const content = result.content;

    // Extract key information
    const lines = content.split("\n");
    const summary = {
      totalLines: lines.length,
      preview: lines.slice(0, 10).join("\n"),
      ending: lines.length > 10 ? lines.slice(-5).join("\n") : null,
    };

    return {
      ...result,
      content: `[File Read - ${summary.totalLines} lines]
First 10 lines:
${summary.preview}
${summary.ending ? `\nLast 5 lines:\n${summary.ending}` : ""}`,
    };
  }

  private compressCommandOutput(result: ToolResultMessage): ToolResultMessage {
    const output = result.content;
    const lines = output.split("\n");

    // Keep first few lines and summary
    const preview = lines.slice(0, 20).join("\n");
    const summary = {
      totalLines: lines.length,
      containsError: output.toLowerCase().includes("error"),
      exitCode: extractExitCode(output),
    };

    return {
      ...result,
      content: `[Command Output]
Status: ${summary.containsError ? "⚠️ Contains errors" : "✓ Success"}
Lines: ${summary.totalLines}
${preview}
${summary.totalLines > 20 ? `\n... (${summary.totalLines - 20} more lines)` : ""}`,
    };
  }

  private compressDirectoryList(result: ToolResultMessage): ToolResultMessage {
    const content = result.content;
    const files = content.split("\n");

    return {
      ...result,
      content: `[Directory Listing - ${files.length} items]
${files.slice(0, 20).join("\n")}
${files.length > 20 ? `\n... and ${files.length - 20} more items` : ""}`,
    };
  }

  private compressGitLog(result: ToolResultMessage): ToolResultMessage {
    const log = result.content;
    const commits = log.split("\n\n");

    // Keep recent commits, summarize old ones
    const recent = commits.slice(0, 5);
    const oldCount = commits.length - 5;

    return {
      ...result,
      content: `[Git Log - ${commits.length} commits]
Recent commits:
${recent.join("\n\n")}
${oldCount > 0 ? `\n... and ${oldCount} older commits` : ""}`,
    };
  }

  private defaultCompress(result: ToolResultMessage, originalLength: number): ToolResultMessage {
    const truncated = result.content.slice(0, 2000);
    return {
      ...result,
      content: `[Result truncated from ${originalLength} chars]
${truncated}
... (truncated)`,
    };
  }
}
```

**Pros**:

- ✅ Significant token savings
- ✅ Tool-specific intelligence
- ✅ Fast (no LLM calls)
- ✅ Preserves essential information

**Cons**:

- ⚠️ May lose important details
- ⚠️ Requires per-tool logic

**Best For**: Agents that make many tool calls with verbose outputs

## Strategy 7: Conversation Checkpointing

**Concept**: Create "save points" in conversation with full state.

```typescript
interface ConversationCheckpoint {
  readonly id: string;
  readonly timestamp: Date;
  readonly summary: string;
  readonly state: ConversationState;
  readonly messages: ChatMessage[]; // Full history up to this point
}

interface ConversationState {
  readonly currentTask?: string;
  readonly decisions: readonly Decision[];
  readonly facts: readonly Fact[];
  readonly context: Record<string, unknown>;
}

class CheckpointManager {
  async createCheckpoint(
    conversationId: string,
    messages: ChatMessage[],
  ): Effect.Effect<ConversationCheckpoint, Error, LLMService> {
    return Effect.gen(function* () {
      const llm = yield* LLMServiceTag;

      // Summarize conversation up to this point
      const summary = yield* llm.chat({
        messages: [
          {
            role: "user",
            content: `Summarize this conversation focusing on:
- Current task/goal
- Decisions made
- Important facts learned
- Next steps

${formatMessages(messages)}`,
          },
        ],
        model: "gpt-4o-mini",
      });

      // Extract structured state
      const state = yield* extractState(messages);

      return {
        id: uuid(),
        timestamp: new Date(),
        summary: summary.content,
        state,
        messages,
      };
    });
  }

  loadFromCheckpoint(checkpoint: ConversationCheckpoint): ChatMessage[] {
    // Instead of full history, use checkpoint summary
    return [
      {
        role: "system",
        content: `[Previous conversation checkpoint]
${checkpoint.summary}

Current state:
- Task: ${checkpoint.state.currentTask}
- Decisions: ${checkpoint.state.decisions.length}
- Facts learned: ${checkpoint.state.facts.length}`,
      },
    ];
  }
}

// Auto-checkpoint at natural breakpoints
function shouldCreateCheckpoint(messages: ChatMessage[], lastCheckpoint?: Date): boolean {
  // Checkpoint every 50 messages
  if (messages.length % 50 === 0) return true;

  // Checkpoint after major task completion
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role === "assistant" && indicatesCompletion(lastMessage.content)) {
    return true;
  }

  // Checkpoint if been 30 minutes since last
  if (lastCheckpoint) {
    const elapsed = Date.now() - lastCheckpoint.getTime();
    if (elapsed > 30 * 60 * 1000) return true;
  }

  return false;
}
```

**Pros**:

- ✅ Can resume conversations cleanly
- ✅ Preserves full history if needed
- ✅ Natural conversation breaks

**Cons**:

- ❌ Storage overhead
- ❌ When to checkpoint is tricky
- ⚠️ May lose context between checkpoints

**Best For**: Long-running conversations with natural task boundaries

## Strategy 8: Hybrid Multi-Strategy Approach (Recommended)

**Concept**: Combine multiple strategies for optimal results.

```typescript
class HybridContextManager {
  constructor(
    private readonly summarizer: HierarchicalSummarizer,
    private readonly importanceScorer: ImportanceScorer,
    private readonly toolCompressor: ToolCallCompressor,
    private readonly checkpointManager: CheckpointManager,
  ) {}

  async manageContext(
    messages: ChatMessage[],
    config: ContextManagementConfig,
  ): Effect.Effect<ChatMessage[], Error, LLMService> {
    return Effect.gen(
      function* (this: HybridContextManager) {
        const { maxTokens, currentQuery, conversationId } = config;

        // Step 1: Compress tool calls (fast, no cost)
        const withCompressedTools = this.compressToolCalls(messages);

        // Step 2: Check if we need more aggressive compression
        const currentTokens = estimateTokens(withCompressedTools);

        if (currentTokens <= maxTokens) {
          return withCompressedTools; // We're good!
        }

        // Step 3: Apply importance filtering
        const important = filterByImportance(
          withCompressedTools,
          maxTokens * 0.8, // Leave room for summaries
          this.importanceScorer,
        );

        // Step 4: If still too large, create checkpoint and summarize old messages
        if (estimateTokens(important) > maxTokens) {
          // Recent messages (keep in full)
          const recent = important.slice(-20);

          // Older messages (summarize)
          const old = important.slice(0, -20);

          if (old.length > 0) {
            // Check for existing checkpoint
            const checkpoint = yield* this.checkpointManager.loadLatest(conversationId);

            if (checkpoint) {
              // Use checkpoint instead of old messages
              const checkpointMessage = this.checkpointManager.loadFromCheckpoint(checkpoint);
              return [...checkpointMessage, ...recent];
            } else {
              // Create hierarchical summary
              const summary = yield* this.summarizer.createHierarchy(old);
              return [
                {
                  role: "system",
                  content: `[Previous conversation]: ${summary.level2}`,
                },
                ...recent,
              ];
            }
          }

          return recent;
        }

        return important;
      }.bind(this),
    );
  }

  private compressToolCalls(messages: ChatMessage[]): ChatMessage[] {
    const compressed: ChatMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "tool") {
        // Find corresponding tool call
        const toolCallMsg = messages
          .slice(0, i)
          .reverse()
          .find((m) => m.role === "assistant" && m.tool_calls);

        if (toolCallMsg?.tool_calls) {
          const toolCall = toolCallMsg.tool_calls.find((tc) => tc.id === msg.tool_call_id);

          if (toolCall) {
            compressed.push(this.toolCompressor.compress(toolCall, msg));
            continue;
          }
        }
      }

      compressed.push(msg);
    }

    return compressed;
  }
}

interface ContextManagementConfig {
  readonly maxTokens: number;
  readonly currentQuery: string;
  readonly conversationId: string;
  readonly preserveRecent: number; // Always keep this many recent messages
  readonly strategy: "aggressive" | "balanced" | "conservative";
}
```

## Strategy Comparison Matrix

| Strategy                 | Speed  | Cost       | Quality    | Complexity | Best For           |
| ------------------------ | ------ | ---------- | ---------- | ---------- | ------------------ |
| **Sliding Window**       | ⚡⚡⚡ | 💰 Free    | ⭐⭐       | 🔧 Simple  | Short tasks        |
| **Summarization**        | ⚡⚡   | 💰💰       | ⭐⭐⭐⭐   | 🔧🔧       | Long conversations |
| **Importance Filtering** | ⚡⚡⚡ | 💰 Free    | ⭐⭐⭐     | 🔧🔧       | Mixed content      |
| **Hierarchical**         | ⚡     | 💰💰💰     | ⭐⭐⭐⭐⭐ | 🔧🔧🔧     | Very long history  |
| **Semantic Filtering**   | ⚡⚡   | 💰💰       | ⭐⭐⭐⭐   | 🔧🔧       | Topic changes      |
| **Tool Compression**     | ⚡⚡⚡ | 💰 Free    | ⭐⭐⭐⭐   | 🔧🔧       | Tool-heavy         |
| **Checkpointing**        | ⚡⚡⚡ | 💰 Storage | ⭐⭐⭐⭐   | 🔧🔧       | Long sessions      |
| **Hybrid**               | ⚡⚡   | 💰💰       | ⭐⭐⭐⭐⭐ | 🔧🔧🔧     | **Recommended**    |

## When to Apply Each Strategy

```typescript
function selectStrategy(context: AnalysisContext): Strategy {
  const { messageCount, currentTokens, hasLongHistory, toolCallRatio, conversationAge } = context;

  // Quick decisions for common cases
  if (currentTokens < 50000) {
    return "none"; // No compression needed
  }

  if (toolCallRatio > 0.6) {
    return "tool_compression"; // Mostly tool calls
  }

  if (messageCount < 50) {
    return "sliding_window"; // Short conversation
  }

  if (hasLongHistory && conversationAge > 3600000) {
    // >1 hour
    return "checkpointing"; // Long session
  }

  // Default: Hybrid approach
  return "hybrid";
}
```

## Implementation Roadmap

### Phase 1: Basic Compression (Week 1)

- [ ] Sliding window implementation
- [ ] Tool call compression
- [ ] Token estimation utilities
- [ ] Configuration system

### Phase 2: Intelligent Filtering (Week 2)

- [ ] Importance scoring
- [ ] Message filtering
- [ ] Heuristic tuning

### Phase 3: Summarization (Week 3)

- [ ] LLM-based summarization
- [ ] Hierarchical summaries
- [ ] Summary caching

### Phase 4: Advanced Features (Week 4+)

- [ ] Semantic filtering (embeddings)
- [ ] Checkpointing system
- [ ] Hybrid manager
- [ ] Auto-strategy selection

## Best Practices

### 1. Always Keep Recent Messages

```typescript
// Never compress the last N messages
const ALWAYS_KEEP_RECENT = 10;

const recent = messages.slice(-ALWAYS_KEEP_RECENT);
const compressible = messages.slice(0, -ALWAYS_KEEP_RECENT);
```

### 2. Preserve System Prompts

```typescript
const systemPrompts = messages.filter((m) => m.role === "system");
// Always include system prompts unmodified
```

### 3. Maintain Chronological Order

```typescript
// After filtering/scoring, re-sort by original order
filtered.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));
```

### 4. Monitor Compression Impact

```typescript
interface CompressionMetrics {
  readonly originalTokens: number;
  readonly compressedTokens: number;
  readonly compressionRatio: number;
  readonly messagesRemoved: number;
  readonly strategy: string;
}

function trackCompression(
  original: ChatMessage[],
  compressed: ChatMessage[],
  strategy: string,
): CompressionMetrics {
  return {
    originalTokens: estimateTokens(original),
    compressedTokens: estimateTokens(compressed),
    compressionRatio: estimateTokens(compressed) / estimateTokens(original),
    messagesRemoved: original.length - compressed.length,
    strategy,
  };
}
```

### 5. Provide Compression Transparency

```typescript
// Add metadata about compression
const compressedContext: ChatMessage[] = [
  {
    role: "system",
    content: `[Note: Previous conversation compressed. Original: 37,000 tokens → Compressed: 8,000 tokens. Summary available if needed.]`,
  },
  ...compressedMessages,
];
```

## CLI Configuration

```yaml
# ~/.jazz/config.yaml
context_management:
  enabled: true
  strategy: hybrid # sliding_window, summarization, importance, hybrid

  # Token limits
  max_tokens: 100000 # Stay well below model limit
  warning_threshold: 80000 # Warn user
  compression_threshold: 50000 # Start compressing

  # Sliding window config
  sliding_window:
    max_messages: 50
    keep_system_prompts: true

  # Summarization config
  summarization:
    chunk_size: 20 # Messages per summary
    style: factual # brief, detailed, factual
    model: gpt-4o-mini
    cache_summaries: true

  # Importance filtering
  importance:
    user_message_weight: 5
    recency_weight: 3
    decision_weight: 4
    action_weight: 3

  # Tool compression
  tool_compression:
    enabled: true
    max_output_length: 2000
    compress_successful_only: false

  # Checkpointing
  checkpointing:
    enabled: true
    frequency: 50 # Every N messages
    storage_path: ~/.jazz/checkpoints/
```

## Monitoring & Debugging

```bash
# View context stats
$ jazz context stats

Context Window Statistics:
  Current tokens: 45,230 / 100,000 (45%)
  Messages: 127
  Compression: Active (hybrid strategy)
  Last compression: 2 minutes ago

  Token breakdown:
    System prompt: 2,000
    Messages: 28,000
    Tool calls: 8,000
    Tool results: 7,230

# View compression history
$ jazz context history

Compression History:
  [10:23] Hybrid: 67K → 45K tokens (33% reduction)
  [10:15] Tool: 54K → 48K tokens (11% reduction)
  [10:05] None: Below threshold

# Test compression strategy
$ jazz context test --strategy summarization --dry-run

Testing summarization strategy:
  Input: 127 messages, 67,000 tokens
  Output: 15 messages, 12,000 tokens
  Compression: 82%
  Estimated cost: $0.03
  Estimated time: 3.2s
```

## Summary

**Key Takeaways**:

1. **No one-size-fits-all**: Different strategies for different scenarios
2. **Start simple**: Tool compression + sliding window covers 80% of cases
3. **Hybrid is best**: Combine strategies for optimal results
4. **Monitor always**: Track compression impact on quality
5. **Keep recent intact**: Never compress last 10-20 messages

**Recommended Approach for Jazz**:

```
Phase 1: Tool compression + Sliding window (simple, fast)
Phase 2: Add importance filtering (smarter)
Phase 3: Add summarization for long conversations (complete)
Phase 4: Full hybrid with checkpointing (production-ready)
```

Context management is crucial for Jazz to handle long-running automations! 🚀

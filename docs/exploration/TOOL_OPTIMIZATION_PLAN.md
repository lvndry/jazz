# Jazz Tool Performance Optimization - Implementation Plan

## Overview
Target: Reduce token overhead by 80%+ through intelligent tool selection and response management

**Current state:**
- 50+ tools × ~350 tokens = 17,500 tokens/request (wasted)
- Complete tools passed every time (no filtering)
- Hardcoded 4,000 char truncation (no intelligence)
- Native function calling supported but not optimized

---

## Phase 1: Smart Tool Selection (80% token reduction)

### 1.1 Tool Embeddings & VectorDB
- [ ] Create tool embeddings from descriptions + parameter schemas
- [ ] Add vector store interface (local: HNSW, optional: Pinecone/Chroma)
- [ ] Embed all 50+ tools at startup: `tools: {name, embedding, metadata}`
- [ ] Implement similarity search: `searchTools(query: string, limit: 10)`
- [ ] Benchmark: Current 17,500 → Target 3,500 tokens (80% reduction)

**Implementation:**
```typescript
// src/core/agent/tools/tool-embeddings.ts
interface ToolEmbedding {
  name: string;
  description: string;
  embedding: number[768];
  parameters: Record<string, any>;
  tags: string[];
}

class ToolEmbeddingStore {
  async searchRelevantTools(userQuery: string, maxTools: number = 10): Promise<string[]>
}
```

### 1.2 Dynamic Tool Registration
- [ ] Modify `register-tools.ts` to accept tool list parameter
- [ ] Update `AgentRunner` to filter tools before passing to LLM
- [ ] Implement `buildDynamicToolList(userInput: string, availableTools: string[])`
- [ ] Cache tool selections for 5 min (similar queries)
- [ ] Test: Verify only relevant tools appear in prompt

**Implementation:**
```typescript
// In agent-loop.ts before calling LLM
const relevantToolNames = yield* toolRegistry.searchRelevantTools(
  userInput,
  maxTools: 15 // Limit to 15 most relevant
);
const filteredTools = availableTools.filter(t => relevantToolNames.includes(t.name));
```

### 1.3 Context-Aware Tool Addition (AST-lite)
- [ ] File type detection: Check current directory for project type
- [ ] Language detection: Look at file extensions (.ts, .py, .go)
- [ ] Git-aware: if `git status` is clean, reduce git tools exposure
- [ ] MCP-aware: Only register MCP tools if server is actively used
- [ ] Rule-based heuristics:
  ```
  If current dir has *.ts files: prioritize TypeScript tools
  If no git repo: deprioritize all git tools
  If in /documents: prioritize file reading, deprioritize code tools
  ```

---

## Phase 2: Intelligent Response Filtering (60% better compression)

### 2.1 Adaptive Truncation by Tool Type
- [ ] Create tool-specific response budgets:
    - `ls`: 1,000 chars (directory listings compress well)
    - `read_file`: 2,000 chars (code needs more context)
    - `git_diff`: 3,000 chars (diffs are critical)
    - `grep`: 2,000 chars (patterns need context)
    - Generic: 1,500 chars
- [ ] Implement in `tool-result-summarizer.ts`: `getToolBudget(toolName: string)`
- [ ] Add compression: Remove duplicate paths, collapse similar results
- [ ] Benchmark: Measure info retention at various limits

### 2.2 Semantic Response Filtering
- [ ] Add LLM-based result summarization for large outputs:
  ```typescript
  // For responses > budget
  if (result.length > budget) {
    const summary = yield* llmService.summarize(
      `Summarize these tool results concisely: ${result}`,
      maxLength: budget
    );
    return summary;
  }
  ```
- [ ] Priority-based extraction: Extract errors first, then results, then metadata
- [ ] Structured output preservation: If JSON/CSV, truncate rows not columns
- [ ] Streaming summarization: Process chunks as they arrive

### 2.3 Response Caching
- [ ] Cache repeated tool calls (same args within conversation)
- [ ] Key: `toolName + JSON.stringify(args) + conversationId`
- [ ] TTL: 5 minutes per conversation
- [ ] Invalidate on: file modifications, git state changes
- [ ] Reduces duplicate tool calls by estimated 30%

---

## Phase 3: Optimize Native Function Calling

### 3.1 ai-sdk Configuration Optimization
- [ ] Verify tools passed correctly to ai-sdk: `streamText({ tools: tools })`
- [ ] Check token usage tracking: `promptTokens` includes tool definitions
- [ ] Add metrics: Track tokens specifically for tool definitions
- [ ] Create baseline: Measure current token usage per request
- [ ] Document: Verify OpenAI vs Anthropic syntax in ai-sdk

### 3.2 Tool Definition Optimization
- [ ] Minify tool schemas: Remove whitespace, shorten descriptions
- [ ] Parameter reduction: Remove optional params from description, keep in schema only
- [ ] Example removal: Move examples to docs, out of tool definition
- [ ] Estimated savings: 20% reduction in tool definition size

### 3.3 Streaming Tool Responses
- [ ] Enable tool streaming if provider supports it
- [ ] Progressive tool execution: Start executing while LLM generates
- [ ] Parallel tool execution: Execute independent tools concurrently  
- [ ] Add `Promise.all()` where tools don't depend on each other

---

## Phase 4: Advanced Optimizations

### 4.1 Tool Grouping (Token Efficient)
- [ ] Combine similar tools: 
  ```typescript
  // Instead of separate tools:
  - read_file_json
  - read_file_text  
  // Use single tool:
  - read_file(format: 'json' | 'text' | 'binary')
  ```
- [ ] Reduce tool count from 50 → ~30 tools (40% reduction)
- [ ] Migrate existing tools with backward compatibility

### 4.2 Adaptive Tool Limits
- [ ] Implement `getToolLimit(sessionLength: number)`:
  ```typescript
  First 3 messages: 8 tools (establish context)
  Messages 4-10: 12 tools (normal operation)
  Long sessions (10+): 15 tools (more needed)
  ```
- [ ] Context window adaptation: 
  - 4k token limit: 8 tools max
  - 16k token limit: 15 tools max
  - 32k+ token limit: 20 tools max

### 4.3 Tool Relevance Feedback Loop
- [ ] Track which tools are actually used per query type
- [ ] Build usage statistics: `queryType → [tool1, tool2, tool3]`
- [ ] Create suggestion engine: Recommend tools based on similar queries
- [ ] Reinforcement learning: Adjust embeddings based on successful tool usage

---

## Phase 5: Monitoring & Testing

### 5.1 Metrics & Benchmarks
- [ ] Current baseline metrics:
  - Average tokens per request (prompt + tools)
  - Token distribution: tools vs prompt vs completion
  - Average tool count per request
- [ ] After each phase: Re-measure and compare
- [ ] Target: 80% token reduction overall
- [ ] Dashboard: Token usage over time per conversation

### 5.2 A/B Testing Framework
- [ ] Feature flags for each optimization:
  ```typescript
  flags: {
    toolEmbeddings: true,
    dynamicTruncation: false,
    responseCaching: true
  }
  ```
- [ ] Gradual rollout: Test with 10% of requests
- [ ] Compare: Success rate, token usage, latency
- [ ] Rollback: Easy disable if issues

### 5.3 Regression Testing
- [ ] Test suite: Fixed queries with known tool requirements
- [ ] Verify: Correct tools still appear for each query type
- [ ] Measure: False negative rate (missing critical tools)
- [ ] Target: <5% false negative rate acceptable

---

## Implementation Roadmap

### Sprint 1 (Week 1-2): Foundation
- Week 1: Tool embeddings store (Phase 1.1, 1.2)
- Week 2: Dynamic registration + basic filtering

### Sprint 2 (Week 3-4): Response Optimization  
- Week 3: Tool-specific budgets + compression (Phase 2.1, 2.2)
- Week 4: Response caching (Phase 2.3)

### Sprint 3 (Week 5-6): Native Optimization
- Week 5: ai-sdk tuning + metrics (Phase 3.1, 3.2)
- Week 6: Streaming optimization (Phase 3.3)

### Sprint 4 (Week 7-8): Polish
- Week 7: Tool grouping + adaptive limits (Phase 4.1, 4.2)
- Week 8: Monitoring + testing (Phase 5)

---

## Expected Impact

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| Tokens per request | 17,500 | 3,500 | 80% reduction |
| Avg tool count | 50+ | 10-15 | 70-80% reduction |
| Token cost per 1k requests | $52.50 | $10.50 | $42 saved |
| Latency | Baseline | -20% | Faster LLM responses |
| Context retention | 100% | 95%+ | Minimal info loss |

---

## Files to Create/Modify

**Core:**
- `/src/core/agent/tools/tool-embeddings.ts` (NEW)
- `/src/core/agent/agent-prompt.ts` (MODIFY - add filtering)
- `/src/core/utils/tool-result-summarizer.ts` (MODIFY - budget system)

**Registry:**
- `/src/core/agent/tools/register-tools.ts` (MODIFY - dynamic registration)
- `/src/core/interfaces/tool-registry.ts` (MODIFY - add search interface)

**Execution:**
- `/src/core/agent/execution/agent-loop.ts` (MODIFY - filter tools)
- `/src/core/agent/execution/tool-executor.ts` (MODIFY - add caching)

**Services:**
- `/src/services/llm/tool-llm.ts` (NEW - for semantic summarization)

This is a **high-impact, mid-complexity** project that will significantly reduce costs while maintaining or improving assistant quality.
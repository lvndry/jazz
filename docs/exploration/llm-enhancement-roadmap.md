# Jazz LLM Layer Enhancement Roadmap


> Note: This roadmap focuses on the LLM layer (tool selection, context, chains). For product positioning and long-term differentiation, see:
> - [Jazz Differentiation Thesis: Capability OS + Terminal Workstation](./jazz-capability-os-terminal-workstation.md)

## 🎯 Vision Statement
Transform Jazz from "agent that uses tools" to "intelligent agent that *intelligently* uses tools" - making tool selection context-aware, optimizing context usage by 3-5x, and dramatically improving response quality while reducing costs.

---

## 📋 Phase 1: Dynamic Tool Selection (Immediate Impact - Week 1-2)

### 1.1 Tool Embedding System
**Priority: P0** | **Impact: High** | **Effort: Medium**

- Create embedding service using SQLite-vec (no external dependencies)
- Embed tool schemas: name, description, parameters, examples
- Create lightweight vector search for tool selection
- Implement tool routing: Only send top-10 most relevant tools per turn

**Benefits:**
- 50-70% reduction in prompt tokens
- Faster inference (LLM doesn't parse irrelevant tools)
- Better tool selection accuracy
- Lower costs

**Files to create/modify:**
```
src/services/vector/
  - tool-embeddings.ts  # Embedding service
  - tool-router.ts      # Tool selection logic
src/core/agent/tools/tool-registry.ts  # Add embedding on registration
src/core/agent/agent-runner.ts         # Use router before prompt
```

**Metrics to track:**
- Tokens saved per turn
- Tool selection accuracy (manual review 100 conversations)
- Response latency reduction

---

### 1.2 Progressive Tool Disclosure
**Priority: P0** | **Impact: High** | **Effort: Medium**

Don't show all tool details upfront. Two-tier system:

```
Tier 1 (always in prompt):
- Tool name
- One-line description
- Category

Tier 2 (loaded on-demand):
- Full parameter schemas
- Examples
- Detailed descriptions
```

When LLM says "I'll use tool X", auto-append full schema before tool call.

**Benefits:**
- Further 30-40% token reduction
- Keep prompt lightweight
- Full power when needed

---

## 📋 Phase 2: Tool Response Intelligence (Week 2-3)

### 2.1 Smart Response Filtering
**Priority: P0** | **Impact: High** | **Effort: Medium**

Create post-processors for tool outputs:

```typescript
interface ToolResponseProcessor {
  (output: string): string; // Raw → Filtered
}

const processors = {
  grep: extractRelevantMatches,
  read_file: summarizeFileContent,
  find: summarizeFileList,
  http_request: extractRelevantJsonData,
  git_log: extractKeyCommits,
}
```

**Example transformations:**
- `grep` returning 200 lines → "Found 8 matches: [context snippets]"
- `read_file` 500 lines → "File overview: [structure, key functions]"
- `http_request` huge JSON → Extract requested fields only

**Benefits:**
- 60-80% reduction in tool response tokens
- Cleaner LLM context
- Faster second LLM turn
- Less context window pressure

---

### 2.2 Tool-Specific LLM Chains
**Priority: P1** | **Impact: Medium** | **Effort: High**

For complex tools, use sub-agents:

```
User: "Find all TODOs in my codebase"

Main Agent:
├─ Tool: find_files(pattern: "**/*.ts", name: "TODO")
├─ Delegate to: [Code Analyzer Sub-Agent]
   ├─ Input: List of 50 files with TODOs
   ├─ Task: Analyze each, categorize, prioritize
   ├─ Returns: Summary only
└─ Present: "Found 23 TODOs: 5 critical, 12 medium, 6 low priority"
```

**Benefits:**
- Maintain context window
- Parallel processing
- Specialized understanding

---

## 📋 Phase 3: Context Architecture (Week 3-4)

### 3.1 Hierarchical Context Management
**Priority: P1** | **Impact: High** | **Effort: High**

Current: Linear conversation history
Better: Structured context with importance levels

```
Context Tiers:
○ Tier 0 (Critical): Always keep
  - System prompt
  - Current goal/task
  - Recent tool results (last 3 turns)

○ Tier 1 (Important): Compress when needed
  - Conversation history
  - Previous tool results (summarized)

○ Tier 2 (Reference): Search on demand
  - Old conversation turns
  - Tool results from far back
  - Vector search retrieves when relevant
```

**Implementation:**
- Store full history in vector DB
- Context window management service
- Automatic compression strategies
- Importance scoring for conversation turns

**Benefits:**
- 3-5x effective context capacity
- Can handle hour-long sessions
- Better long-term coherence

---

### 3.2 Dynamic System Prompts
**Priority: P2** | **Impact: Medium** | **Effort: Medium**

Don't use one-size-fits-all system prompt:

```typescript
function getDynamicSystemPrompt(context: ConversationContext) {
  const base = BASE_PROMPT;
  
  if (context.technicalTask) {
    base += TECHNICAL_EMPHASIS;
  }
  
  if (context.requiresFileOperations) {
    base += FILE_OPERATION_GUIDELINES;
    // Also add relevant file tools dynamically
  }
  
  if (context.lastError) {
    base += ERROR_RECOVERY_HINTS;
  }
  
  return base;
}
```

**Benefits:**
- More relevant instructions
- Smaller prompts
- Better performance

---

## 📋 Phase 4: Advanced LLM Features (Week 4-5)

### 4.1 Native Function Calling Integration
**Priority: P1** | **Impact: Medium** | **Effort: Medium**

Implement provider-native tool calling:

```typescript
interface LLMProviderAdapter {
  name: ProviderName;
  supportNativeTools: boolean;
  adaptTools(tools: Tool[]): ToolFormat;
  parseResponse(response: unknown): ToolCall[] | string;
}
```

- OpenAI: Functions/parallel tools
- Anthropic: XML-style function calling
- Google: Function calling API
- Fallback: JSON schema in prompt (current)

**Benefits:**
- More reliable tool calls
- Better structured responses
- Reduced parsing errors

---

### 4.2 Parallel Tool Execution
**Priority: P2** | **Impact: Medium** | **Effort: High**

Detect independent tools, run them concurrently:

```
LLM requests:
1. git_status
2. read_file("package.json")
3. grep("TODO", "src/")

Analysis: All independent → Run in parallel

Result: ~3x faster total execution
```

**Implementation:**
- Tool dependency graph
- Parallel execution engine
- Result aggregation
- Error handling per tool

**Benefits:**
- 2-5x speedup for multi-tool plans
- Better UX

---

### 4.3 Predictive Tool Execution & Caching
**Priority: P3** | **Impact: Low** | **Effort: High**

Based on patterns, pre-execute likely tools:

```
User: "Check my email for..."
→ Predict: gmail_search, gmail_read
→ Pre-fetch (cache): Recent emails
→ LLM requests tool → Instantly available
```

**Benefits:**
- Zero-latency for common patterns
- Better UX for power users

---

## 📋 Phase 5: Observability & Intelligence (Ongoing)

### 5.1 Performance Metrics
**Priority: P1** | **Impact: Medium** | **Effort: Medium**

Track everything:
- Tokens per conversation (input/output/system)
- Tool selection accuracy (manual review)
- Latency per turn
- Context compression ratio
- User satisfaction (success rate)

**Implementation:**
```
src/services/analytics/
  - metrics-collector.ts
  - conversation-analyzer.ts
  - optimization-suggestions.ts
```

**Benefits:**
- Data-driven improvements
- Identify bottlenecks
- Measure ROI of changes

---

### 5.2 Adaptive Behavior
**Priority: P3** | **Impact: High** | **Effort: Very High**

Agent learns from interactions:

- Tool usage patterns per user
- Preferred workflows per task type
- Common failure patterns → Auto-adjust prompts
- A/B testing framework for prompt changes

**Benefits:**
- Gets smarter over time
- Personalized experience

---

## 💰 Cost/Benefit Estimates

### Phase 1 (Tool Selection):
- **Cost:** ~2 weeks dev time
- **Benefit:** Token reduction 50-70% → 35-50% cost savings
- **User Impact:** Faster responses, better accuracy

### Phase 2 (Response Intelligence):
- **Cost:** ~1 week dev time
- **Benefit:** Token reduction 40-60% → 20-30% additional savings
- **User Impact:** Better context management, longer sessions possible

### Phase 3 (Context Architecture):
- **Cost:** ~2 weeks dev time
- **Benefit:** 3-5x context capacity → Can handle 5x longer tasks
- **User Impact:** Can work on large codebases, complex multi-step tasks

**Total potential:** 70-85% token reduction + 3-5x context capacity = 10x improvement in capability per dollar spent

---

## 🏁 Quick Wins (Can Ship This Week)

1. **Tool categorization in prompt** (30 min)
   - Group tools by category
   - Makes prompt more scannable

2. **Tool response limits** (1 hour)
   - grep: Limit to first 20 matches with context
   - read_file: Truncate with "... (150 more lines)"

3. **Tool usage examples cleanup** (2 hours)
   - Remove redundant examples
   - Keep only diverse, representative ones

4. **Streaming improvements** (3 hours)
   - Better loading indicators
   - Stream tool execution progress

---

## 🔬 Experimental (Future Research)

### Tool Use Prediction Model
Train small model to predict which tools are needed given a query: 50KB model → 90% accuracy → Lightning-fast tool selection

### Tool-to-Tool Communication
Tools can expose "insights" that other tools can use: `find` can tell `grep` which files are relevant

### Multi-Agent Orchestration
Master agent routes to specialized agents (coder, researcher, sysadmin) based on task domain

---

## 🎬 Getting Started Checklist

- [ ] Set up SQLite vector store
- [ ] Create tool embedding pipeline
- [ ] Implement tool router service
- [ ] Modify agent-runner to use router
- [ ] Create tool response processors
- [ ] Add context compression service
- [ ] Implement hierarchical context management
- [ ] Add metrics collection
- [ ] Run benchmarks before/after
- [ ] A/B test with beta users

---

**Last Updated:** 2026-02-13
**Status:** Ready for implementation
**Priority Order:** Phase 1 → Phase 2 → Phase 3 → (Phase 4 → 5 as time permits)

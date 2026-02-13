:construction: Jazz Tool Performance Optimization - Tracking Todo

**Goal**: Reduce tool token overhead by 80% (17,500 → 3,500 tokens/request)

---

## Phase 1: Tool Selection & Embeddings (Week 1)

### 1.1 Tool Embedding Infrastructure
- [ ] Create embedding service: `/src/core/agent/tools/tool-embeddings.ts`
- [ ] Generate embeddings for all 50+ tools at startup
- [ ] Implement similarity search: `searchRelevantTools(query, limit)`
- [ ] Add vector store (local HNSWLib): in-memory, <5MB
- [ ] Benchmark: Verify embeddings quality with sample queries

### 1.2 Dynamic Tool Registration
- [ ] Modify `register-tools.ts`: Accept tool list parameter
- [ ] Update `AgentRunner`: Filter tools before LLM calls
- [ ] Create API: `buildDynamicToolList(userQuery, maxTools=12)`
- [ ] Add caching: 5-min TTL for tool selections
- [ ] Test: Verify filtered tools appear in prompts
  
### 1.3 Context-Aware Heuristics
- [ ] File type detector: Check extensions (.ts, .py, .go)
- [ ] Git-aware: Skip git tools if not in repo
- [ ] Language priorities: Rank tools by project type
- [ ] Rule engine: 5-10 simple if/then rules
- [ ] Measure: Track false negative rate

**Milestone 1**: Tool count reduced from 50 → 12-15 per request

---

## Phase 2: Response Filtering (Week 2)

### 2.1 Adaptive Truncation
- [ ] Modify `tool-result-summarizer.ts`: Add tool-specific budgets
- [ ] Create budgets: `ls:1k, read_file:2k, git_diff:3k, grep:2k, default:1.5k`
- [ ] Implement compression: Remove duplicates, collapse patterns
- [ ] Add metrics: Track bytes before/after filtering
- [ ] Benchmark: Measure info retention at different limits

### 2.2 Semantic Summarization
- [ ] Create `LLM Summarizer` mini-agent for large results
- [ ] Implement fallback: Summarize only if result > budget * 2
- [ ] Priority extraction: Errors → Results → Metadata hierarchy
- [ ] Structured preservation: JSON keeps schema, truncates rows
- [ ] Add safety: Never summarize critical tools (git_diff, grep)

### 2.3 Response Caching
- [ ] Add cache layer: `Map<toolName+args, result>`
- [ ] Key strategy: `toolName + JSON.stringify(sortedArgs)`
- [ ] TTL: 5 minutes per conversation
- [ ] Invalidation: File change detection (mtime check)
- [ ] Test: Verify 30% reduction in duplicate calls

**Milestone 2**: Tokens reduced by 60% with <5% info loss

---

## Phase 3: Native Function Calling Optimization (Week 3)

### 3.1 ai-sdk Optimization
- [ ] Audit tool passing: Verify `streamText({ tools })` usage
- [ ] Add token telemetry: Track tokens in tool definitions
- [ ] Create baseline: Measure current token usage/request
- [ ] Documentation: Annotate OpenAI vs Anthropic nuances
- [ ] Metrics dashboard: Token usage by tool category

### 3.2 Tool Definition Minification
- [ ] Remove whitespace from tool schemas
- [ ] Extract examples from descriptions to external docs
- [ ] Shorten parameter descriptions (50 chars max)
- [ ] Keep full schemas but minify descriptions
- [ ] Measure: 20% token reduction per tool

### 3.3 Parallel Execution
- [ ] Identify independent tool dependencies
- [ ] Implement `Promise.all()` for concurrent tools
- [ ] Streaming tool results: Process as they arrive
- [ ] Add progress tracking for parallel execution
- [ ] Error handling: Fail individual tools, not all

**Milestone 3**: Delivery latency -15%, token efficiency +25%

---

## Phase 4: Advanced Optimizations (Week 4)

### 4.1 Tool Consolidation
- [ ] Audit similar tools: Find 10-15 candidates to merge
- [ ] Create `read_file` unified: format param (json|text|binary)
- [ ] Combine write_file + edit_file (mode param)
- [ ] Maintain backward compatibility: Old names alias to new
- [ ] Test: All existing workflows still work

### 4.2 Adaptive Limits
- [ ] Session-based scaling: 
  - First 3 turns: 8 tools
  - Turns 4-10: 12 tools
  - 10+ turns: 15 tools
- [ ] Context window detection:
  - 4k limit: 8 tools max
  - 16k limit: 15 tools max
  - 32k+ limit: 20 tools max
- [ ] Add config: `toolSelectionStrategy: 'dynamic' | 'static'`
- [ ] Test with different conversation lengths

### 4.3 Tool Usage Analytics
- [ ] Track: Query → [tool1, tool2, tool3] relationships
- [ ] Build frequency map: Count tool usage per query type
- [ ] Create suggestion engine: Based on similar queries
- [ ] Reinforcement loop: Adjust embeddings based on success
- [ ] Dashboard: Visualization of tool usage patterns

**Milestone 4**: Tool count 50 → 30 core tools, 80% token reduction achieved

---

## Phase 5: Monitoring & Validation (Ongoing)

### 5.1 Metrics & Benchmarks
- [ ] Establish baseline: 50+ tools current token cost
- [ ] After each phase: Re-run benchmarks
- [ ] Track: False negative rate (missing critical tools)
- [ ] Monitor: User satisfaction impact
- [ ] Alert if token usage > 5,000/request after optimization

### 5.2 A/B Testing Framework
- [ ] Feature flags for optimizations:
  ```typescript
  flags: {
    toolEmbeddings: true,  // Phase 1
    dynamicTruncation: false,  // Phase 2
    responseCaching: true,
    toolConsolidation: false  // Phase 4
  }
  ```
- [ ] Shadow mode: Run new system, compare with old
- [ ] Gradual rollout: 10% → 50% → 100%
- [ ] Rollback plan: One-click disable if issues

### 5.3 Regression Testing Suite
- [ ] Test dataset: 50-100 diverse queries
- [ ] Known tool requirements for each
- [ ] Automated validation: Are critical tools present?
- [ ] Alert threshold: >5% false negative rate
- [ ] Daily CI: Run on new commits

**Milestone 5**: 95% accuracy, production-ready with monitoring

---

## Phase 6: Documentation (Week 4)

- [ ] Update architecture docs: Tool selection flow
- [ ] API documentation: Tool embedding interface
- [ ] Best practices: When to use each optimization
- [ ] Migration guide: For custom tool developers
- [ ] Performance report: Before/after metrics
- [ ] Blog post: Share learnings with community

---

## Success Criteria

- [ ] **Token reduction**: 17,500 → 3,500 tokens (80%)
- [ ] **Tool count**: 50+ → 12-15 per request (70%)
- [ ] **Info retention**: >95% (false negative <5%)
- [ ] **Latency**: -15% (faster response times)
- [ ] **No regressions**: All existing functionality works
- [ ] **Monitoring**: Dashboard tracking token usage
- [ ] **Rollback ready**: Can disable in production if needed

---

## Files to Modify/Created

**New Files (8):**
- `/src/core/agent/tools/tool-embeddings.ts`
- `/src/core/agent/tools/tool-selector.ts`
- `/src/core/agent/tools/tool-analytics.ts`
- `/src/core/services/llm/tool-summarizer.ts`
- `/src/core/utils/vector-store-local.ts`
- `/src/core/utils/response-caching.ts`
- `/src/config/tool-optimization.ts`
- `/src/tests/tool-selection.test.ts`

**Modified Files (12):**
- `/src/core/agent/tools/register-tools.ts`
- `/src/core/agent/agent-prompt.ts`
- `/src/core/agent/agent-runner.ts`
- `/src/core/agent/execution/agent-loop.ts`
- `/src/core/agent/execution/tool-executor.ts`
- `/src/core/utils/tool-result-summarizer.ts`
- `/src/core/interfaces/tool-registry.ts`
- `/src/services/llm/llm-service.ts`
- `/src/services/llm/streaming-executor.ts`
- `/src/core/agent/execution/streaming-executor.ts`
- `/src/core/agent/execution/batch-executor.ts`
- `/src/cli/main.ts` (add --debug flag for tool metrics)

---

## Risk Mitigation

- [ ] **False negatives**: Extensive testing, keep backup mode
- [ ] **Embedding quality**: Use high-quality embeddings, benchmark first
- [ ] **Caching issues**: TTL + invalidation, don't cache critical results
- [ ] **Tool consolidation**: Backward compatibility layer
- [ ] **Performance regression**: Measure at each phase
- [ ] **Production issues**: Feature flags for instant rollback

---

**Started**: 2026-02-13  
**Estimated**: 4 weeks  
**Owner**: @lvndry  
**Status**: 🚀 Ready to start (Phase 1)

# Tool Result Evaluation for Context Window Optimization

## Overview

This document explores the concept of having AI agents evaluate the usefulness of tool results immediately after receiving them. The goal is to improve agent efficiency by:

1. Helping agents understand which information in their context is actually useful
2. Enabling intelligent context window management by pruning low-value tool results
3. Providing feedback loops for tool usage patterns and effectiveness

---

## Problem Statement

Current AI agents accumulate tool results in their context window without any mechanism to assess relevance or utility. This leads to:

- **Context bloat**: Every tool result stays in context, regardless of usefulness
- **Reduced efficiency**: Important information gets buried in irrelevant data
- **Higher costs**: Larger context windows mean more tokens to process
- **Slower responses**: More content to parse on every inference
- **Lost focus**: Agents may get distracted by irrelevant information

---

## Proposed Solution: Post-Tool Evaluation

After each tool invocation, the agent evaluates the result's usefulness for accomplishing its current task.

### Simple Scoring Approach

**Score Categories:**

- ✅ **CRITICAL** - Essential information, directly solves the problem
- 👍 **USEFUL** - Relevant and helpful for the task
- 🤷 **NEUTRAL** - Somewhat related but not particularly helpful
- 👎 **NOT_USEFUL** - Irrelevant or unhelpful for current task
- 🚫 **DISTRACTION** - Actively misleading or taking agent off track

**Example Implementation:**

```json
{
  "tool": "view_file",
  "file": "/src/config.ts",
  "evaluation": {
    "score": "USEFUL",
    "reasoning": "Found the configuration structure needed, but still need to see how it's used in main.ts",
    "confidence": 0.8
  }
}
```

### Sophisticated Evaluation Framework

A more advanced system could include multiple dimensions:

#### 1. **Relevance Scoring** (0.0 - 1.0)

How directly does this result relate to the current task?

```typescript
interface RelevanceScore {
  taskAlignment: number; // How well it aligns with stated task
  informationValue: number; // Amount of new, useful information
  actionability: number; // Can agent act on this information?
}
```

#### 2. **Utility Classification**

What type of utility does this provide?

- **ANSWER_FOUND**: Direct answer to a question
- **CONTEXT_BUILDING**: Background information for understanding
- **BLOCKER_IDENTIFIED**: Revealed a problem or obstacle
- **PATH_ELIMINATED**: Ruled out an approach (negative utility)
- **CONFIRMATION**: Validated existing understanding
- **EXPLORATION**: Exploratory, not immediately useful

#### 3. **Temporal Relevance**

When will this information be useful?

- **IMMEDIATE**: Needed for next action
- **SHORT_TERM**: Needed within next few steps
- **LONG_TERM**: May be needed later in task
- **REFERENCE**: Keep for potential future reference
- **EXPIRED**: Was useful but no longer needed

#### 4. **Information Quality**

How good is the information itself?

```typescript
interface QualityMetrics {
  completeness: number; // 0-1: Is the information complete?
  clarity: number; // 0-1: Is it clear and understandable?
  accuracy: number; // 0-1: Confidence in accuracy
  specificity: number; // 0-1: Specific vs. generic info
}
```

---

## Implementation Strategies

### Option 1: Inline Evaluation (After Each Tool)

Agent evaluates immediately after receiving each tool result.

**Pros:**

- Fresh context - evaluation happens when task state is clear
- Can inform immediate next steps
- Natural reasoning flow

**Cons:**

- Adds latency to each tool call
- May not have full picture yet
- Extra tokens for evaluation

**Implementation:**

```typescript
async function executeToolWithEvaluation(tool: Tool, params: any) {
  const result = await tool.execute(params);

  const evaluation = await agent.evaluate({
    prompt: `Evaluate the usefulness of this tool result for your current task.
    
    Current task: ${currentTask}
    Tool used: ${tool.name}
    Result: ${result}
    
    Provide:
    1. Utility score: CRITICAL | USEFUL | NEUTRAL | NOT_USEFUL | DISTRACTION
    2. Brief reasoning (1-2 sentences)
    3. Confidence (0.0-1.0)`,

    schema: EvaluationSchema,
  });

  return {
    result,
    evaluation,
    timestamp: Date.now(),
  };
}
```

### Option 2: Batch Evaluation (Periodic Review)

Agent periodically reviews all recent tool results together.

**Pros:**

- Can compare relative utilities
- Better understanding of which info is still needed
- More efficient - one evaluation for multiple results
- Can identify redundant information

**Cons:**

- Less timely - evaluation happens after the fact
- May forget context of older results

**Implementation:**

```typescript
async function batchEvaluateTools(toolResults: ToolResult[], currentTask: string) {
  const evaluation = await agent.evaluate({
    prompt: `Review the following tool results and rank their usefulness for the current task.
    
    Current task: ${currentTask}
    
    Tool results:
    ${toolResults.map((r, i) => `[${i}] ${r.tool}: ${truncate(r.result, 200)}`).join("\n")}
    
    For each result, provide a usefulness score and indicate which ones can be removed from context.`,

    schema: BatchEvaluationSchema,
  });

  return evaluation;
}
```

### Option 3: Implicit Evaluation (Usage-Based)

Track which tool results the agent actually references in subsequent actions.

**Pros:**

- No explicit evaluation overhead
- Based on actual usage, not predictions
- Completely objective

**Cons:**

- Reactive, not proactive
- Can't prune context until after the fact
- Doesn't capture "reference" information that might be needed later

**Implementation:**

```typescript
class ContextManager {
  private toolResults: Map<string, ToolResultWithMetrics> = new Map();

  trackReference(toolResultId: string) {
    const result = this.toolResults.get(toolResultId);
    if (result) {
      result.referenceCount++;
      result.lastReferenced = Date.now();
    }
  }

  pruneContext() {
    // Remove results with zero references after some time
    const OLD_THRESHOLD = 5 * 60 * 1000; // 5 minutes

    for (const [id, result] of this.toolResults) {
      if (result.referenceCount === 0 && Date.now() - result.timestamp > OLD_THRESHOLD) {
        this.toolResults.delete(id);
      }
    }
  }
}
```

### Option 4: Hybrid Approach

Combine multiple strategies for robustness.

1. **Quick inline scoring** - Simple USEFUL/NOT_USEFUL after each tool
2. **Usage tracking** - Monitor actual references
3. **Periodic batch review** - Re-evaluate context every N tools
4. **Smart pruning** - Remove based on age + score + usage

---

## Context Management Strategies

Once we have usefulness evaluations, how do we use them?

### 1. **Tiered Context System**

Organize context into tiers based on utility:

```typescript
interface TieredContext {
  critical: ToolResult[]; // Always kept, highest priority
  active: ToolResult[]; // Recently useful, keep accessible
  reference: ToolResult[]; // May be needed, compress or summarize
  archived: ToolResult[]; // Low utility, can be removed
}
```

### 2. **Rolling Window with Smart Retention**

Keep only the most recent N tool results, but make exceptions for high-value items.

```typescript
class SmartContextWindow {
  maxSize: number = 20;

  shouldRetain(result: ToolResult): boolean {
    return (
      result.evaluation.score === "CRITICAL" ||
      result.referenceCount > 2 ||
      result.temporalRelevance === "IMMEDIATE"
    );
  }

  prune() {
    // Remove oldest, lowest-value results first
    this.results.sort((a, b) => {
      if (this.shouldRetain(a) && !this.shouldRetain(b)) return -1;
      if (!this.shouldRetain(a) && this.shouldRetain(b)) return 1;
      return a.timestamp - b.timestamp;
    });

    while (this.results.length > this.maxSize) {
      const candidate = this.results.pop();
      if (this.shouldRetain(candidate)) {
        this.results.push(candidate);
        break;
      }
    }
  }
}
```

### 3. **Summarization of Low-Priority Results**

Instead of removing, compress low-value results into summaries.

```typescript
async function summarizeMultipleResults(results: ToolResult[]): Promise<string> {
  return await agent.summarize({
    prompt: `Summarize these tool results into a brief overview:
    ${results.map((r) => r.result).join("\n---\n")}`,

    maxTokens: 200,
  });
}
```

### 4. **Semantic Deduplication**

Remove redundant information based on semantic similarity.

```typescript
async function deduplicateResults(results: ToolResult[]): Promise<ToolResult[]> {
  const embeddings = await Promise.all(results.map((r) => getEmbedding(r.result)));

  const unique: ToolResult[] = [];
  const threshold = 0.85; // Cosine similarity threshold

  for (let i = 0; i < results.length; i++) {
    const isDuplicate = unique.some((u) => {
      const similarity = cosineSimilarity(embeddings[i], getEmbedding(u.result));
      return similarity > threshold;
    });

    if (!isDuplicate) {
      unique.push(results[i]);
    }
  }

  return unique;
}
```

---

## Evaluation Prompt Design

### Simple Prompt

```
Evaluate the usefulness of this tool result for your current task.

Current Task: [task description]
Tool Used: [tool name]
Result: [tool result]

Rate as: CRITICAL | USEFUL | NEUTRAL | NOT_USEFUL | DISTRACTION
Explain in one sentence why you gave this rating.
```

### Detailed Prompt

```
Analyze this tool result across multiple dimensions:

CONTEXT:
- Current Goal: [goal]
- Current Approach: [approach]
- Outstanding Questions: [questions]

TOOL RESULT:
- Tool: [name]
- Result: [result]

EVALUATE:
1. Relevance (0-1): How directly does this address your current needs?
2. Information Value (0-1): How much new, useful information did you gain?
3. Actionability (0-1): Can you take concrete actions based on this?
4. Temporal Utility: When is this useful? (IMMEDIATE | SHORT_TERM | LONG_TERM | REFERENCE)
5. Quality (0-1): How complete and clear is the information?

6. Overall Classification: CRITICAL | USEFUL | NEUTRAL | NOT_USEFUL | DISTRACTION

7. Reasoning: Explain your evaluation in 2-3 sentences.

8. Next Action: Does this change what you should do next? If so, how?
```

### Meta-Evaluation Prompt

```
Review your recent tool usage efficiency:

TOOLS USED (last 10):
[list of tools with evaluations]

ANALYSIS:
1. What percentage of tool calls were actually useful?
2. Did you use any tools that were distractions?
3. Are there patterns of inefficient tool usage?
4. What could you do differently to be more efficient?
```

---

## Benefits & Trade-offs

### Benefits

✅ **Improved Focus**

- Agent keeps attention on relevant information
- Reduced distraction from unhelpful results

✅ **Cost Optimization**

- Smaller context windows = fewer tokens = lower costs
- More efficient token usage

✅ **Better Performance**

- Faster inference with smaller contexts
- Better reasoning with signal vs. noise ratio improvement

✅ **Learning & Adaptation**

- Agents learn which tools are most helpful
- Can inform tool selection strategies

✅ **Debugging & Analysis**

- Understand why agents used certain tools
- Identify inefficient tool usage patterns
- Measure agent decision quality

### Trade-offs

❌ **Added Latency**

- Each evaluation takes time
- May slow down agent responses

❌ **Token Overhead**

- Evaluation prompts consume tokens
- May offset savings from pruning

❌ **Evaluation Accuracy**

- Agent may misjudge utility
- Risk of removing important information

❌ **Complexity**

- More moving parts in the system
- Harder to debug and maintain

❌ **Context Loss**

- Pruned information is gone
- May need it later unexpectedly

---

## Advanced Concepts

### 1. **Predictive Utility Modeling**

Train a model to predict tool result utility before executing the tool.

```typescript
interface PredictiveModel {
  // Predict usefulness before execution
  predictUtility(tool: string, params: any, context: Context): Promise<number>;

  // Update model based on actual utility
  learn(prediction: number, actual: number): void;
}

// Use to decide whether to even call the tool
if ((await model.predictUtility("view_file", params, context)) > 0.5) {
  const result = await viewFile(params);
}
```

### 2. **Context Window Budgeting**

Allocate token budget across different types of information.

```typescript
interface ContextBudget {
  critical: { allocated: 2000; used: 1500 };
  useful: { allocated: 3000; used: 2100 };
  reference: { allocated: 1000; used: 800 };
}

// When budget exceeded, prune lowest-value items in that tier
```

### 3. **Collaborative Filtering for Multi-Agent Systems**

Share utility evaluations across agent instances to learn collectively.

```typescript
interface SharedKnowledge {
  toolUtility: Map<string, AggregateScore>;

  recordUtility(tool: string, params: any, score: number, context: string): void;

  // Get aggregated utility for a tool+params combo
  getExpectedUtility(tool: string, params: any, context: string): number;
}
```

### 4. **Adaptive Evaluation Granularity**

Adjust how thoroughly we evaluate based on context.

```typescript
function getEvaluationStrategy(context: Context): EvaluationStrategy {
  // Simple evaluation when context is small
  if (context.size < 1000) {
    return "QUICK";
  }

  // Detailed when approaching limit
  if (context.size > 8000) {
    return "THOROUGH";
  }

  // Batch periodically in normal cases
  return "PERIODIC";
}
```

---

## Experimental Design

To validate this approach, we should run experiments:

### Experiment 1: Baseline Comparison

**Setup:**

- Run agent on standard tasks with and without evaluation
- Measure: task completion time, cost, success rate

**Metrics:**

- Average context window size
- Token usage per task
- Task completion rate
- Response quality

### Experiment 2: Evaluation Strategy Comparison

**Setup:**

- Compare inline vs. batch vs. implicit evaluation
- Same tasks across all strategies

**Metrics:**

- Accuracy of utility predictions
- Overhead (time and tokens)
- Context efficiency

### Experiment 3: Pruning Aggressiveness

**Setup:**

- Test different pruning thresholds
- Very conservative vs. moderate vs. aggressive

**Metrics:**

- False removal rate (needed info pruned)
- Context size reduction
- Impact on task success

### Experiment 4: Long-Running Tasks

**Setup:**

- Multi-step tasks that accumulate lots of context
- Measure where evaluation helps most

**Metrics:**

- Context growth curve
- Point where pruning becomes critical
- Information retrieval success rate

---

## Implementation Roadmap

### Phase 1: Basic Inline Evaluation (MVP)

1. Add simple 3-point scale evaluation after each tool call
2. Store evaluations alongside tool results
3. Log evaluations for analysis (no pruning yet)

### Phase 2: Context Pruning

1. Implement basic pruning logic (remove NOT_USEFUL after N tools)
2. Add safety: never prune recent results
3. Monitor for false removals

### Phase 3: Smart Context Management

1. Implement tiered context system
2. Add usage tracking
3. Develop hybrid pruning strategy

### Phase 4: Optimization & Learning

1. Add batch evaluation support
2. Implement summarization of low-priority results
3. Build analytics dashboard for evaluation patterns

### Phase 5: Advanced Features

1. Predictive utility modeling
2. Cross-agent knowledge sharing
3. Adaptive evaluation strategies

---

## Open Questions

1. **What's the right balance between evaluation overhead and context savings?**
   - Need empirical testing with real workloads

2. **How do we handle long-term reference information?**
   - Documentation, API references, etc. may not be immediately useful but needed later

3. **Can agents accurately evaluate their own tool results?**
   - Do we need human feedback or separate evaluator models?

4. **What about tools with side effects?**
   - A file write might not produce "useful" output but is still important

5. **How do we evaluate negative results?**
   - "File not found" is useful information (eliminated a path)

6. **Should evaluation be task-specific or global?**
   - Some info may not help current task but useful for overall session

7. **How do we prevent over-pruning?**
   - What safety mechanisms ensure we don't lose critical info?

---

## Conclusion

Tool result evaluation presents a promising approach to improve agent efficiency and context management. The key is finding the right balance between:

- **Thoroughness** vs. **Speed** in evaluation
- **Retention** vs. **Pruning** in context management
- **Complexity** vs. **Simplicity** in implementation

Starting with a simple scoring system and iteratively adding sophistication based on real-world performance data seems like the most pragmatic path forward.

The hybrid approach combining inline quick scoring, usage tracking, and periodic batch review offers the best balance of benefits while mitigating individual weaknesses of each strategy.

---

## Further Reading

- Context window optimization techniques
- Relevance feedback in information retrieval
- Active learning and sample efficiency
- Memory-augmented neural networks
- Attention mechanisms and importance weighting

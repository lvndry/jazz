# Workflow Orchestration Layer

## Overview

The Workflow Orchestration Layer provides a declarative way to coordinate multiple agents in
complex, multi-step workflows. Instead of treating agents as tools that can call each other (which
leads to deep nesting and context loss), workflows define explicit dependencies and data flow
between agent executions.

## Architecture

### Core Concepts

**Workflow**: A directed acyclic graph (DAG) of agent executions with explicit dependencies.

**Step**: A single agent execution within a workflow, with inputs derived from previous steps.

**Orchestrator**: The execution engine that manages step scheduling, parallel execution, and error
handling.

## Type Definitions

```typescript
import { Effect, Schema } from "effect";
import type { Agent, AgentResponse } from "../agent/types";

export interface WorkflowStep {
  /** Unique identifier for this step */
  readonly id: string;

  /** The agent to execute for this step */
  readonly agentId: string;

  /**
   * Input for the agent. Can be:
   * - Static string
   * - Function that transforms previous step results
   */
  readonly input: string | ((previousResults: WorkflowContext) => string);

  /** Step IDs that must complete before this step runs */
  readonly dependsOn?: readonly string[];

  /** Maximum iterations for this agent execution */
  readonly maxIterations?: number;

  /** Timeout for this step in milliseconds */
  readonly timeout?: number;

  /** Whether to continue workflow if this step fails */
  readonly optional?: boolean;

  /** Metadata for tracking and debugging */
  readonly metadata?: Record<string, unknown>;
}

export interface Workflow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly WorkflowStep[];

  /**
   * Execution mode:
   * - sequential: Execute steps in order
   * - parallel: Execute independent steps concurrently
   * - adaptive: Automatically detect parallelizable steps
   */
  readonly executionMode?: "sequential" | "parallel" | "adaptive";

  /** Global timeout for entire workflow */
  readonly timeout?: number;

  /** Retry policy for failed steps */
  readonly retryPolicy?: WorkflowRetryPolicy;
}

export interface WorkflowRetryPolicy {
  readonly maxRetries: number;
  readonly delay: number;
  readonly backoff: "linear" | "exponential" | "fixed";
  readonly retryableErrors?: readonly string[];
}

export interface WorkflowContext {
  /** Results from completed steps, keyed by step ID */
  readonly results: Record<string, unknown>;

  /** Metadata about step executions */
  readonly executions: Record<string, StepExecution>;

  /** Global workflow state */
  readonly state: Record<string, unknown>;
}

export interface StepExecution {
  readonly stepId: string;
  readonly agentId: string;
  readonly startTime: Date;
  readonly endTime?: Date;
  readonly duration?: number;
  readonly status: "pending" | "running" | "completed" | "failed" | "skipped";
  readonly iterations?: number;
  readonly toolCalls?: number;
  readonly error?: string;
}

export interface WorkflowResult {
  readonly workflowId: string;
  readonly status: "completed" | "partial" | "failed";
  readonly context: WorkflowContext;
  readonly totalDuration: number;
  readonly stepsExecuted: number;
  readonly stepsFailed: number;
  readonly stepsSkipped: number;
}
```

## Benefits

### 1. **Clear Data Flow**

- Explicit input/output dependencies
- No hidden context passing
- Easy to visualize and debug

### 2. **Parallel Execution**

- Automatic detection of parallelizable steps
- Configurable concurrency limits
- Optimal resource utilization

### 3. **Error Handling**

- Step-level retry policies
- Optional steps that don't fail workflow
- Partial workflow completion support

### 4. **Observability**

- Detailed execution tracking per step
- Duration and iteration metrics
- Clear failure attribution

### 5. **Testability**

- Each step can be tested in isolation
- Mock step results for integration testing
- Validate workflow structure before execution

## Comparison with Agent-as-Tool

| Feature            | Workflow Orchestration              | Agent-as-Tool                    |
| ------------------ | ----------------------------------- | -------------------------------- |
| Context Visibility | ✅ Full visibility of all steps     | ❌ Nested, hard to trace         |
| Parallel Execution | ✅ Native support                   | ❌ Sequential only               |
| Error Recovery     | ✅ Step-level retry, optional steps | ❌ All-or-nothing                |
| Debugging          | ✅ Clear execution graph            | ❌ Deep call stacks              |
| Token Efficiency   | ✅ Shared context, no duplication   | ❌ Repeated context in each call |
| Flexibility        | ⚠️ Requires planning upfront        | ✅ Dynamic, ad-hoc delegation    |

## When to Use

Use **Workflow Orchestration** when:

- ✅ Predefined sequence is optimal
- ✅ Need explicit dependency management
- ✅ Parallel execution is critical
- ✅ No need for agent decision-making
- ✅ Batch processing or scheduled jobs

Prefer **Handoff Pattern** when:

- Need runtime decision making
- Conversational flow is important
- Task requires dynamic adaptation

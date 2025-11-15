# Event-Driven Agent Coordination

## Overview

Event-Driven Agent Coordination enables loosely-coupled, asynchronous communication between agents
through an event bus. Instead of direct invocation or workflows, agents publish and subscribe to
events, allowing for dynamic, reactive behavior and complex multi-agent systems.

## Architecture

### Core Concepts

**Event Bus**: A central message broker that routes events between agents.

**Publisher**: An agent or system component that emits events.

**Subscriber**: An agent that listens for and reacts to specific events.

**Event**: A structured message containing data and metadata about something that happened.

## Type Definitions

```typescript
import { Effect, Queue, Stream, Hub, Fiber, Schedule } from "effect";
import type { Agent } from "../agent/types";

/**
 * Base event type that all events must extend
 */
export interface BaseEvent {
  readonly id: string;
  readonly type: string;
  readonly timestamp: Date;
  readonly source: string; // Agent ID or system component
  readonly correlationId?: string; // For tracing related events
  readonly metadata?: Record<string, unknown>;
}

/**
 * Domain-specific event types
 */
export type AgentEvent =
  | TaskRequestedEvent
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | ToolExecutedEvent
  | DataAvailableEvent
  | AgentStateChangedEvent
  | UserInputReceivedEvent
  | ApprovalRequestedEvent
  | ApprovalGrantedEvent;

export interface TaskRequestedEvent extends BaseEvent {
  readonly type: "task.requested";
  readonly targetAgentId?: string;
  readonly task: string;
  readonly priority: "low" | "normal" | "high" | "urgent";
  readonly context: Record<string, unknown>;
  readonly requester: string;
}
```

## Benefits

### 1. **Loose Coupling**

- Agents don't need to know about each other
- Easy to add/remove agents without affecting others
- Clear separation of concerns

### 2. **Scalability**

- Agents can be distributed across processes/machines
- Natural support for horizontal scaling
- Event bus can be backed by distributed message queue

### 3. **Flexibility**

- Dynamic agent registration
- Agents can subscribe to multiple event types
- Complex patterns like saga, choreography

### 4. **Observability**

- All agent interactions are explicit events
- Easy to trace event flow through correlation IDs
- Natural audit log of system behavior

### 5. **Resilience**

- Agents can fail independently
- Event replay for recovery
- Dead letter queue for failed events

## When to Use

Use **Event-Driven** when:

- Agents need to react to external events (webhooks, file changes, etc.)
- Multiple agents need to respond to the same event
- System needs to scale dynamically
- Long-running, asynchronous processes
- Complex event processing and aggregation

Use **Workflow** when:

- Clear, predefined sequence of steps
- Need explicit dependency management
- Easier debugging and visualization requirements
- Batch processing workflows

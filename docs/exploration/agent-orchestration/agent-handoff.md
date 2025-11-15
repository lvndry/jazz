# Agent Handoff Pattern

## Overview

The **Agent Handoff Pattern** enables agents to dynamically transfer control to other specialized
agents during execution when they encounter tasks outside their expertise or capability. Unlike
workflow orchestration (which is predefined) or simple tool invocation, handoffs are **intelligent,
runtime decisions** made by the agent itself based on the context and its understanding of its own
limitations.

## What Makes Handoff Different?

### Handoff vs Workflow Orchestration vs Agent-as-Tool

| Aspect                      | Handoff Pattern                               | Workflow Orchestration           | Agent-as-Tool                          |
| --------------------------- | --------------------------------------------- | -------------------------------- | -------------------------------------- |
| **Decision Making**         | ✅ Dynamic (agent decides at runtime)         | ❌ Static (predefined flow)      | ⚠️ Agent invokes but less context      |
| **Context Transfer**        | ✅ Explicit, rich context passing             | ⚠️ Step-by-step data flow        | ⚠️ Limited context window              |
| **Return Path**             | ✅ Natural (specialist returns to generalist) | ✅ Defined by workflow           | ❌ Result returned but no conversation |
| **Specialization**          | ✅ Self-organizing based on capabilities      | ✅ Explicit role assignment      | ⚠️ Tools are capabilities, not agents  |
| **Flexibility**             | ✅ Highly adaptive                            | ❌ Fixed structure               | ✅ Ad-hoc invocation                   |
| **When Decided**            | Runtime (LLM decision)                        | Design time (developer decision) | Runtime (LLM decision)                 |
| **Conversation Continuity** | ✅ Maintains conversation context             | ❌ Each step is isolated         | ❌ New conversation per call           |

## Core Concept

Think of handoff like human collaboration:

```
User: "Deploy the app to production"
  ↓
Generalist Agent: "I see you want to deploy. Let me check if tests pass first..."
  ↓
Generalist Agent: "I need help from the Test Specialist"
  ↓
Test Agent: *runs tests* "All tests passed ✓"
  ↓
Generalist Agent: "Great! Now I need the Deploy Specialist"
  ↓
Deploy Agent: *handles deployment* "Deployed to production ✓"
  ↓
Generalist Agent: "Successfully deployed! Here's the summary..."
  ↓
User: *receives complete response*
```

The generalist maintains the conversation thread and orchestrates by intelligently handing off to
specialists.

## Architecture

### Type Definitions

```typescript
import { Effect, Context } from "effect";
import type { Agent, AgentResponse } from "../agent/types";

/**
 * Handoff request from one agent to another
 */
export interface HandoffRequest {
  readonly id: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly reason: string;
  readonly task: string;
  readonly context: HandoffContext;
  readonly timestamp: Date;
  readonly conversationId: string;
  readonly maxIterations?: number;
}

/**
 * Context passed during handoff
 */
export interface HandoffContext {
  /** Original user request */
  readonly originalRequest: string;

  /** Conversation history up to handoff point */
  readonly conversationHistory: readonly ChatMessage[];

  /** Work completed so far */
  readonly completedWork?: Record<string, unknown>;

  /** Specific information needed from specialist */
  readonly requiredCapabilities: readonly string[];

  /** Additional metadata */
  readonly metadata?: Record<string, unknown>;

  /** User ID for tracking */
  readonly userId?: string;

  /** Correlation ID for tracing */
  readonly correlationId?: string;
}

/**
 * Result returned after handoff
 */
export interface HandoffResult {
  readonly handoffId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly success: boolean;
  readonly result: unknown;
  readonly duration: number;
  readonly iterations: number;
  readonly conversationSummary?: string;
  readonly error?: string;
}

/**
 * Agent capability declaration
 */
export interface AgentCapabilityProfile {
  readonly agentId: string;
  readonly agentName: string;
  readonly specialization: string;
  readonly capabilities: readonly string[];
  readonly description: string;
  readonly examples: readonly string[];
  readonly acceptsHandoffs: boolean;
}

/**
 * Handoff routing service
 */
export interface HandoffRouter {
  /**
   * Register an agent's capabilities
   */
  readonly registerAgent: (profile: AgentCapabilityProfile) => Effect.Effect<void, Error>;

  /**
   * Find the best agent for a capability
   */
  readonly findAgentForCapability: (capability: string) => Effect.Effect<Agent | null, Error>;

  /**
   * Find the best agent for a task
   */
  readonly findAgentForTask: (task: string) => Effect.Effect<Agent | null, Error, LLMService>;

  /**
   * List all available agents for handoff
   */
  readonly listAvailableAgents: () => Effect.Effect<readonly AgentCapabilityProfile[], never>;
}
```

## Implementation

### 1. Handoff Tool

This tool is what allows agents to initiate handoffs:

```typescript
import { Effect } from "effect";
import { defineTool } from "./base-tool";
import { z } from "zod";
import { v4 as uuid } from "uuid";

export function createHandoffTool() {
  return defineTool({
    name: "handoff_to_specialist",
    description: `Transfer control to a specialized agent when you encounter a task that requires specific expertise you don't have.

Use this when:
- The task requires specialized knowledge (e.g., testing, deployment, security analysis)
- You recognize a task is outside your core competency
- The user explicitly requests a specialist
- You need deep expertise in a specific domain

Provide clear context about what you've done so far and what you need the specialist to accomplish.`,
    tags: ["coordination", "handoff", "delegation"],
    parameters: z.object({
      specialist_type: z
        .string()
        .describe(
          "The type of specialist needed (e.g., 'testing', 'deployment', 'security', 'data-analysis')",
        ),
      task: z.string().describe("Clear description of what you need the specialist to do"),
      reason: z.string().describe("Why you're handing off this task to a specialist"),
      context: z
        .record(z.unknown())
        .optional()
        .describe("Important context or data the specialist needs to know"),
      required_capabilities: z
        .array(z.string())
        .optional()
        .describe("Specific capabilities needed from the specialist"),
    }),
    validate: (args) => {
      const result = z
        .object({
          specialist_type: z.string().min(1),
          task: z.string().min(1),
          reason: z.string().min(1),
          context: z.record(z.unknown()).optional(),
          required_capabilities: z.array(z.string()).optional(),
        })
        .safeParse(args);

      return result.success
        ? { valid: true, value: result.data }
        : { valid: false, errors: result.error.errors.map((e) => e.message) };
    },
    handler: (args, executionContext) => {
      return Effect.gen(function* () {
        const handoffService = yield* HandoffServiceTag;
        const logger = yield* LoggerServiceTag;
        const router = yield* HandoffRouterTag;

        const { specialist_type, task, reason, context, required_capabilities } = args;

        yield* logger.info("Initiating handoff", {
          fromAgent: executionContext.agentId,
          specialistType: specialist_type,
          task,
        });

        // Find appropriate specialist
        const specialist = yield* router.findAgentForCapability(specialist_type);

        if (!specialist) {
          return {
            success: false,
            result: null,
            error: `No specialist found for capability: ${specialist_type}. Please handle this task yourself or ask the user for guidance.`,
          };
        }

        // Create handoff request
        const handoffRequest: HandoffRequest = {
          id: uuid(),
          fromAgentId: executionContext.agentId,
          toAgentId: specialist.id,
          reason,
          task,
          context: {
            originalRequest: executionContext.userInput || "",
            conversationHistory: executionContext.conversationHistory || [],
            completedWork: context,
            requiredCapabilities: required_capabilities || [specialist_type],
            userId: executionContext.userId,
            correlationId: executionContext.conversationId,
          },
          timestamp: new Date(),
          conversationId: executionContext.conversationId,
        };

        // Execute handoff
        const result = yield* handoffService.executeHandoff(handoffRequest);

        if (!result.success) {
          return {
            success: false,
            result: null,
            error: `Handoff to ${specialist.name} failed: ${result.error}`,
          };
        }

        yield* logger.info("Handoff completed successfully", {
          handoffId: handoffRequest.id,
          specialist: specialist.name,
          duration: result.duration,
        });

        return {
          success: true,
          result: {
            specialist_name: result.agentName,
            specialist_response: result.result,
            handoff_summary: `${specialist.name} (${specialist_type} specialist) completed the task: ${task}`,
            conversation_summary: result.conversationSummary,
            iterations: result.iterations,
          },
        };
      });
    },
  });
}
```

### 2. Handoff Service

```typescript
import { Context, Effect, Ref } from "effect";
import { AgentRunner } from "../agent-runner";
import { getAgentById } from "../agent-service";

export interface HandoffService {
  readonly executeHandoff: (
    request: HandoffRequest,
  ) => Effect.Effect<
    HandoffResult,
    Error,
    LLMService | ToolRegistry | LoggerService | ConfigService
  >;

  readonly getHandoffHistory: (
    conversationId: string,
  ) => Effect.Effect<readonly HandoffRequest[], never>;
}

export const HandoffServiceTag = Context.GenericTag<HandoffService>("HandoffService");

export class DefaultHandoffService implements HandoffService {
  constructor(private readonly handoffHistory: Ref.Ref<Map<string, HandoffRequest[]>>) {}

  static create(): Effect.Effect<DefaultHandoffService, never> {
    return Effect.gen(function* () {
      const history = yield* Ref.make(new Map<string, HandoffRequest[]>());
      return new DefaultHandoffService(history);
    });
  }

  executeHandoff(
    request: HandoffRequest,
  ): Effect.Effect<
    HandoffResult,
    Error,
    LLMService | ToolRegistry | LoggerService | ConfigService | AgentService
  > {
    return Effect.gen(
      function* (this: DefaultHandoffService) {
        const logger = yield* LoggerServiceTag;
        const startTime = Date.now();

        yield* logger.info("Executing handoff", {
          handoffId: request.id,
          from: request.fromAgentId,
          to: request.toAgentId,
          task: request.task,
        });

        // Store handoff in history
        yield* Ref.update(this.handoffHistory, (history) => {
          const conversationHistory = history.get(request.conversationId) || [];
          return new Map(history).set(request.conversationId, [...conversationHistory, request]);
        });

        // Get the specialist agent
        const specialist = yield* getAgentById(request.toAgentId);

        // Build enriched input for specialist
        const specialistInput = buildSpecialistInput(request);

        try {
          // Execute the specialist agent
          const response = yield* AgentRunner.run({
            agent: specialist,
            userInput: specialistInput,
            conversationId: `handoff-${request.id}`,
            userId: request.context.userId,
            maxIterations: request.maxIterations ?? 15,
            conversationHistory: [], // Start fresh but with context in prompt
          });

          const duration = Date.now() - startTime;

          yield* logger.info("Handoff completed", {
            handoffId: request.id,
            specialist: specialist.name,
            duration,
            iterations: response.iterations,
          });

          return {
            handoffId: request.id,
            agentId: specialist.id,
            agentName: specialist.name,
            success: true,
            result: response.response,
            duration,
            iterations: response.iterations,
            conversationSummary: summarizeConversation(response),
          };
        } catch (error) {
          const duration = Date.now() - startTime;
          const errorMessage = error instanceof Error ? error.message : String(error);

          yield* logger.error("Handoff failed", {
            handoffId: request.id,
            specialist: specialist.name,
            error: errorMessage,
          });

          return {
            handoffId: request.id,
            agentId: specialist.id,
            agentName: specialist.name,
            success: false,
            result: null,
            duration,
            iterations: 0,
            error: errorMessage,
          };
        }
      }.bind(this),
    );
  }

  getHandoffHistory(conversationId: string): Effect.Effect<readonly HandoffRequest[], never> {
    return Effect.gen(
      function* (this: DefaultHandoffService) {
        const history = yield* Ref.get(this.handoffHistory);
        return history.get(conversationId) || [];
      }.bind(this),
    );
  }
}

/**
 * Build enriched input for specialist agent
 */
function buildSpecialistInput(request: HandoffRequest): string {
  const contextSection = request.context.completedWork
    ? `\n\n## Work Completed So Far\n${JSON.stringify(request.context.completedWork, null, 2)}`
    : "";

  const historySection =
    request.context.conversationHistory.length > 0
      ? `\n\n## Recent Conversation Context\n${formatConversationHistory(request.context.conversationHistory.slice(-5))}`
      : "";

  return `You are receiving a handoff from another agent. Here's the context:

## Original User Request
${request.context.originalRequest}

## Why You're Receiving This Handoff
${request.reason}

## Your Specific Task
${request.task}

## Required Capabilities
${request.context.requiredCapabilities.join(", ")}
${contextSection}
${historySection}

Please complete this task using your specialized expertise and provide a clear, comprehensive response.`;
}

/**
 * Format conversation history for context
 */
function formatConversationHistory(messages: readonly ChatMessage[]): string {
  return messages
    .map((msg) => {
      if (msg.role === "user") return `User: ${msg.content}`;
      if (msg.role === "assistant") return `Assistant: ${msg.content}`;
      if (msg.role === "tool") return `Tool (${msg.name}): ${msg.content}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Create a summary of specialist's conversation
 */
function summarizeConversation(response: AgentResponse): string {
  return `Completed in ${response.iterations} iterations, used ${response.toolCalls} tool calls`;
}
```

### 3. Handoff Router

```typescript
import { Effect, Ref, Context } from "effect";

export const HandoffRouterTag = Context.GenericTag<HandoffRouter>("HandoffRouter");

export class DefaultHandoffRouter implements HandoffRouter {
  constructor(private readonly profiles: Ref.Ref<Map<string, AgentCapabilityProfile>>) {}

  static create(): Effect.Effect<DefaultHandoffRouter, never> {
    return Effect.gen(function* () {
      const profiles = yield* Ref.make(new Map<string, AgentCapabilityProfile>());
      return new DefaultHandoffRouter(profiles);
    });
  }

  registerAgent(profile: AgentCapabilityProfile): Effect.Effect<void, Error, LoggerService> {
    return Effect.gen(
      function* (this: DefaultHandoffRouter) {
        const logger = yield* LoggerServiceTag;

        yield* logger.info("Registering agent for handoffs", {
          agentId: profile.agentId,
          agentName: profile.agentName,
          specialization: profile.specialization,
          capabilities: profile.capabilities,
        });

        yield* Ref.update(this.profiles, (profiles) =>
          new Map(profiles).set(profile.agentId, profile),
        );
      }.bind(this),
    );
  }

  findAgentForCapability(capability: string): Effect.Effect<Agent | null, Error, AgentService> {
    return Effect.gen(
      function* (this: DefaultHandoffRouter) {
        const profiles = yield* Ref.get(this.profiles);
        const agentService = yield* AgentServiceTag;

        // Find agent with matching capability
        for (const profile of profiles.values()) {
          if (
            profile.acceptsHandoffs &&
            (profile.capabilities.includes(capability) || profile.specialization === capability)
          ) {
            const agent = yield* agentService.getAgent(profile.agentId);
            return agent;
          }
        }

        return null;
      }.bind(this),
    );
  }

  findAgentForTask(task: string): Effect.Effect<Agent | null, Error, AgentService | LLMService> {
    return Effect.gen(
      function* (this: DefaultHandoffRouter) {
        const profiles = yield* Ref.get(this.profiles);
        const llmService = yield* LLMServiceTag;
        const agentService = yield* AgentServiceTag;

        // Use LLM to match task to best agent
        const profileDescriptions = Array.from(profiles.values())
          .filter((p) => p.acceptsHandoffs)
          .map(
            (p) =>
              `- ${p.agentName} (${p.specialization}): ${p.description}\n  Examples: ${p.examples.join(", ")}`,
          )
          .join("\n");

        const prompt = `Given this task: "${task}"

Which of these specialized agents is best suited to handle it?

${profileDescriptions}

Respond with just the agent name, or "NONE" if no agent is suitable.`;

        const response = yield* llmService.chat({
          messages: [{ role: "user", content: prompt }],
          provider: "openai",
          model: "gpt-4o-mini",
        });

        const agentName = response.content.trim();

        if (agentName === "NONE") {
          return null;
        }

        // Find matching profile
        for (const profile of profiles.values()) {
          if (profile.agentName === agentName) {
            const agent = yield* agentService.getAgent(profile.agentId);
            return agent;
          }
        }

        return null;
      }.bind(this),
    );
  }

  listAvailableAgents(): Effect.Effect<readonly AgentCapabilityProfile[], never> {
    return Effect.gen(
      function* (this: DefaultHandoffRouter) {
        const profiles = yield* Ref.get(this.profiles);
        return Array.from(profiles.values()).filter((p) => p.acceptsHandoffs);
      }.bind(this),
    );
  }
}
```

## Usage Examples

### Example 1: Generalist with Specialist Handoff

```typescript
// Create a generalist agent
const generalist =
  yield *
  agentService.createAgent(
    "general-assistant",
    "A general-purpose assistant that coordinates with specialists",
    {
      agentType: "ai-agent",
      llmProvider: "openai",
      llmModel: "gpt-4o",
      tools: ["handoff_to_specialist", "files", "shell"], // Include handoff tool
    },
  );

// Create specialist agents
const testAgent =
  yield *
  agentService.createAgent("test-specialist", "Expert in running tests and ensuring code quality", {
    agentType: "ai-agent",
    llmProvider: "openai",
    llmModel: "gpt-4o",
    tools: ["shell", "files"],
  });

const deployAgent =
  yield *
  agentService.createAgent("deploy-specialist", "Expert in deploying applications to production", {
    agentType: "ai-agent",
    llmProvider: "openai",
    llmModel: "gpt-4o",
    tools: ["shell", "git", "files"],
  });

// Register specialists with the router
const router = yield * HandoffRouterTag;

yield *
  router.registerAgent({
    agentId: testAgent.id,
    agentName: testAgent.name,
    specialization: "testing",
    capabilities: ["run-tests", "quality-assurance", "test-automation"],
    description: "Runs all types of tests and ensures code quality",
    examples: ["Run unit tests", "Check test coverage", "Run integration tests"],
    acceptsHandoffs: true,
  });

yield *
  router.registerAgent({
    agentId: deployAgent.id,
    agentName: deployAgent.name,
    specialization: "deployment",
    capabilities: ["deploy", "production", "infrastructure"],
    description: "Handles deployment to various environments",
    examples: ["Deploy to production", "Deploy to staging", "Rollback deployment"],
    acceptsHandoffs: true,
  });

// Now when user talks to generalist:
// User: "Deploy the app to production"
// Generalist: *realizes this needs deployment expert*
// Generalist: *uses handoff_to_specialist tool*
// Deploy Specialist: *handles deployment*
// Generalist: *receives result and reports to user*
```

### Example 2: Chain of Handoffs

```typescript
// Complex task that requires multiple specialists
const response =
  yield *
  AgentRunner.run({
    agent: generalist,
    userInput: "I need to deploy the app but make sure all tests pass first",
    conversationId: "conv-123",
  });

// Flow:
// 1. Generalist recognizes need for testing first
// 2. Hands off to Test Specialist → tests pass
// 3. Generalist receives result
// 4. Hands off to Deploy Specialist → deployment succeeds
// 5. Generalist reports final result to user
```

### Example 3: Handoff with Rich Context

```typescript
const response =
  yield *
  AgentRunner.run({
    agent: generalist,
    userInput: "Analyze the security of our authentication system",
    conversationId: "conv-456",
  });

// Generalist might hand off to security specialist with context:
// - Files it has already read
// - Observations it has made
// - Specific concerns to investigate
// - Code patterns it noticed
```

## System Prompt Enhancement

To enable handoffs, enhance the agent's system prompt:

```typescript
const HANDOFF_GUIDANCE = `## Working with Specialists

You have access to specialized agents through the 'handoff_to_specialist' tool. Use this when:

1. **You lack expertise**: The task requires specialized knowledge you don't have
2. **Efficiency**: A specialist can do it better/faster
3. **User requests**: User explicitly asks for a specialist
4. **Complex operations**: Testing, deployment, security audits, etc.

When handing off:
- Clearly explain what you need the specialist to do
- Provide all relevant context from your conversation
- Explain why you're handing off
- After receiving results, synthesize and present them to the user

Available specialists:
{specialist_list}

You remain the primary interface to the user. Specialists help you accomplish tasks, but you maintain the conversation thread.`;
```

## Benefits

### 1. **Natural Specialization**

- Agents self-organize based on actual capabilities
- Mimics how humans collaborate
- Clear separation of expertise

### 2. **Dynamic Adaptation**

- Decisions made at runtime based on context
- Flexible routing to best specialist
- No predetermined workflows

### 3. **Conversation Continuity**

- User interacts with one primary agent
- Context flows naturally through handoffs
- Seamless experience

### 4. **Reduced Complexity per Agent**

- Each agent can be simpler and focused
- Generalist doesn't need all tools
- Specialists are expert in their domain

### 5. **Scalability**

- Easy to add new specialists
- No need to update orchestration logic
- Organic growth of capabilities

## Comparison Summary

```
┌─────────────────────────────────────────────────────┐
│                    USER REQUEST                      │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
         ┌─────────────────┐
         │   Generalist    │  ← Maintains conversation
         │     Agent       │  ← Makes handoff decisions
         └────┬────────────┘
              │
    ┌─────────┼─────────┐
    │         │         │
    ▼         ▼         ▼
┌────────┐ ┌────────┐ ┌────────┐
│  Test  │ │ Deploy │ │Security│  ← Specialists
│ Agent  │ │ Agent  │ │ Agent  │  ← Accept handoffs
└───┬────┘ └───┬────┘ └───┬────┘
    │          │          │
    └──────────┼──────────┘
               │
               ▼
         ┌─────────────────┐
         │   Generalist    │  ← Synthesizes results
         │     Agent       │  ← Reports to user
         └─────────────────┘
               │
               ▼
         ┌─────────────────┐
         │      USER        │
         └─────────────────┘
```

## When to Use Each Pattern

### Use **Handoff** When:

- ✅ Agent needs to make runtime decisions about delegation
- ✅ Clear specialization boundaries (testing, deployment, security)
- ✅ Want natural, conversational flow
- ✅ Single user-facing agent that coordinates
- ✅ Specialists need full context to make decisions

### Use **Workflow Orchestration** When:

- ✅ Predefined sequence is optimal
- ✅ Need explicit dependency management
- ✅ Parallel execution is critical
- ✅ No need for agent decision-making
- ✅ Batch processing or scheduled jobs

### Use **Event-Driven** When:

- ✅ Reactive, asynchronous processing
- ✅ Multiple agents responding to same events
- ✅ Loose coupling is priority
- ✅ Real-time event processing
- ✅ Distributed system

## Implementation Roadmap

### Phase 1: Core Handoff

- [ ] Implement handoff tool
- [ ] Build HandoffService
- [ ] Create HandoffRouter
- [ ] Add capability registration

### Phase 2: Specialist Management

- [ ] CLI for registering specialists
- [ ] Capability discovery
- [ ] Agent matching logic
- [ ] Handoff history tracking

### Phase 3: Enhanced Context

- [ ] Conversation summarization
- [ ] Selective context passing
- [ ] Multi-hop handoffs
- [ ] Circular handoff detection

### Phase 4: Observability

- [ ] Handoff visualization
- [ ] Performance metrics
- [ ] Success rate tracking
- [ ] Context flow tracing

### Phase 5: Advanced Features

- [ ] Capability learning (agents learn which specialists to use)
- [ ] Load balancing across multiple specialists
- [ ] Handoff recommendation system
- [ ] A/B testing of handoff strategies

## Combining Patterns

You can combine handoff with other patterns:

```typescript
// Workflow that uses handoffs internally
const deploymentWorkflow: Workflow = {
  id: "smart-deploy",
  name: "Smart Deployment with Handoffs",
  steps: [
    {
      id: "coordinate",
      agentId: "generalist-coordinator",
      input: "Deploy to production with proper testing",
      // This agent will use handoffs to delegate to specialists
    },
  ],
};

// Event-driven system that triggers handoffs
eventBus.subscribe({ types: ["security.alert"] }, (event) =>
  Effect.gen(function* () {
    // Trigger a handoff to security specialist
    yield* publishHandoffRequest({
      specialistType: "security",
      task: `Investigate security alert: ${event.data}`,
      priority: "urgent",
    });
  }),
);
```

## Conclusion

The **Handoff Pattern** is a powerful middle ground that combines:

- **Flexibility** of agent-as-tool
- **Structure** of workflow orchestration
- **Intelligence** of LLM decision-making

It's particularly well-suited for Jazz because it:

1. Maintains natural conversation flow
2. Enables specialization without complexity
3. Scales organically as you add specialists
4. Gives agents agency in collaboration

For Jazz's vision of agentic automation, handoff should be a **primary pattern** alongside workflows
for complex pipelines and events for reactive systems.

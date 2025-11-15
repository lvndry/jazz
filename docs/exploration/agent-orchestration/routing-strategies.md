# Multi-Pattern Routing Strategies

## Overview

When Jazz supports multiple coordination patterns (Handoff, Workflow, Event-Driven), we need
intelligent routing to decide which pattern to use for a given request. This document explores
various routing strategies and recommends an optimal approach.

## The Routing Challenge

Given a user request, we need to determine:

1. Should we use a **predefined workflow**?
2. Should we use an **agent with handoff** capabilities?
3. Should we use a **simple single agent**?
4. Is this an **event-driven scenario**?

## Routing Strategies

### Strategy 1: Explicit CLI Commands (Simplest)

Users explicitly choose the pattern through different commands.

```bash
# Direct agent conversation (handoff-capable)
jazz chat "Deploy to production"

# Execute a predefined workflow
jazz workflow run deployment-pipeline

# Start event-driven monitoring
jazz monitor start infrastructure-monitor

# Simple single-purpose agent
jazz agent run test-runner "Run all tests"
```

**Pros:**

- ✅ Clear and explicit
- ✅ No routing logic needed
- ✅ User has full control
- ✅ Easy to implement

**Cons:**

- ❌ User must understand patterns
- ❌ Less "intelligent" feeling
- ❌ Friction in choosing

### Strategy 2: Intent Classification (AI-Powered)

Use an LLM to classify the request and route accordingly.

```typescript
export interface RequestIntent {
  readonly intentType: "workflow" | "handoff" | "single-agent" | "event-driven";
  readonly confidence: number;
  readonly reasoning: string;
  readonly suggestedResource?: string; // workflow ID or agent ID
}

export interface IntentClassifier {
  readonly classifyIntent: (
    userRequest: string,
    context?: RequestContext,
  ) => Effect.Effect<RequestIntent, Error, LLMService>;
}

interface RequestContext {
  readonly recentCommands?: readonly string[];
  readonly currentDirectory?: string;
  readonly availableWorkflows?: readonly string[];
  readonly availableAgents?: readonly string[];
  readonly timeOfDay?: string;
  readonly urgency?: "low" | "normal" | "high";
}
```

**Implementation:**

```typescript
import { Effect } from "effect";
import { LLMServiceTag } from "../../services/llm/service";

export class DefaultIntentClassifier implements IntentClassifier {
  classifyIntent(
    userRequest: string,
    context?: RequestContext,
  ): Effect.Effect<RequestIntent, Error, LLMService> {
    return Effect.gen(function* () {
      const llmService = yield* LLMServiceTag;

      const prompt = buildClassificationPrompt(userRequest, context);

      const response = yield* llmService.chat({
        messages: [{ role: "user", content: prompt }],
        provider: "openai",
        model: "gpt-4o-mini", // Fast, cheap model for classification
      });

      const intent = parseIntentResponse(response.content);
      return intent;
    });
  }
}

function buildClassificationPrompt(userRequest: string, context?: RequestContext): string {
  const workflowSection = context?.availableWorkflows
    ? `\n\nAvailable Workflows:\n${context.availableWorkflows.map((w) => `- ${w}`).join("\n")}`
    : "";

  const agentSection = context?.availableAgents
    ? `\n\nAvailable Agents:\n${context.availableAgents.map((a) => `- ${a}`).join("\n")}`
    : "";

  return `Classify this user request and determine the best execution pattern:

Request: "${userRequest}"

## Execution Patterns

1. **WORKFLOW** - Predefined sequence of steps
   - Use when: Request matches a known automated pipeline
   - Examples: "Deploy to production", "Run CI/CD pipeline", "Generate daily report"
   - Characteristics: Repeatable, multi-step, well-defined sequence
   
2. **HANDOFF** - Conversational agent with specialist delegation
   - Use when: Request is exploratory or requires dynamic decisions
   - Examples: "Help me fix this bug", "Analyze security issues", "Investigate performance"
   - Characteristics: Exploratory, requires judgment, benefits from conversation
   
3. **SINGLE_AGENT** - Direct agent execution without handoffs
   - Use when: Task is simple and within one agent's capability
   - Examples: "List my emails", "Read this file", "Search for X"
   - Characteristics: Simple, single-domain, straightforward

4. **EVENT_DRIVEN** - Not applicable for direct requests
   - Only used for reactive scenarios (webhooks, file watching, scheduled tasks)
${workflowSection}${agentSection}

Respond in JSON format:
{
  "intentType": "workflow" | "handoff" | "single-agent",
  "confidence": 0-100,
  "reasoning": "brief explanation",
  "suggestedResource": "workflow/agent name if applicable"
}`;
}

function parseIntentResponse(response: string): RequestIntent {
  try {
    const json = JSON.parse(response);
    return {
      intentType: json.intentType,
      confidence: json.confidence,
      reasoning: json.reasoning,
      suggestedResource: json.suggestedResource,
    };
  } catch {
    // Fallback to handoff if parsing fails
    return {
      intentType: "handoff",
      confidence: 50,
      reasoning: "Failed to parse classification, defaulting to handoff",
    };
  }
}
```

**Pros:**

- ✅ Intelligent routing
- ✅ Seamless user experience
- ✅ Adapts to context
- ✅ Can suggest specific workflows/agents

**Cons:**

- ❌ Additional LLM call (latency + cost)
- ❌ Classification errors possible
- ❌ Complexity in implementation
- ❌ Harder to debug

### Strategy 3: Pattern Matching (Rule-Based)

Use keywords and patterns to route requests.

```typescript
export interface RoutingRule {
  readonly pattern: RegExp;
  readonly keywords: readonly string[];
  readonly intentType: "workflow" | "handoff" | "single-agent";
  readonly priority: number;
  readonly workflowId?: string;
  readonly agentId?: string;
}

export class RuleBasedRouter {
  private rules: RoutingRule[] = [
    // Workflow patterns
    {
      pattern: /deploy.*production|production.*deploy/i,
      keywords: ["deploy", "production"],
      intentType: "workflow",
      workflowId: "production-deployment",
      priority: 100,
    },
    {
      pattern: /run.*ci|run.*pipeline|ci.*pipeline/i,
      keywords: ["ci", "pipeline", "run"],
      intentType: "workflow",
      workflowId: "ci-pipeline",
      priority: 90,
    },
    {
      pattern: /daily.*report|generate.*report/i,
      keywords: ["report", "daily", "generate"],
      intentType: "workflow",
      workflowId: "daily-report",
      priority: 80,
    },

    // Single agent patterns
    {
      pattern: /^list.*emails?$/i,
      keywords: ["list", "email"],
      intentType: "single-agent",
      agentId: "email-agent",
      priority: 70,
    },
    {
      pattern: /^read.*file$/i,
      keywords: ["read", "file"],
      intentType: "single-agent",
      agentId: "file-agent",
      priority: 70,
    },

    // Handoff patterns (lower priority, catch-all)
    {
      pattern: /help|investigate|analyze|debug|fix|improve/i,
      keywords: ["help", "investigate", "analyze", "debug"],
      intentType: "handoff",
      priority: 50,
    },
  ];

  route(userRequest: string): Effect.Effect<RequestIntent, never> {
    return Effect.sync(() => {
      const matchedRules = this.rules
        .filter((rule) => {
          // Check pattern match
          if (rule.pattern.test(userRequest)) return true;

          // Check keyword match
          const requestLower = userRequest.toLowerCase();
          return rule.keywords.some((keyword) => requestLower.includes(keyword));
        })
        .sort((a, b) => b.priority - a.priority);

      if (matchedRules.length === 0) {
        // Default to handoff for unknown requests
        return {
          intentType: "handoff",
          confidence: 50,
          reasoning: "No matching rules, defaulting to handoff",
        };
      }

      const topRule = matchedRules[0];
      return {
        intentType: topRule.intentType,
        confidence: 80,
        reasoning: `Matched rule: ${topRule.pattern}`,
        suggestedResource: topRule.workflowId || topRule.agentId,
      };
    });
  }
}
```

**Pros:**

- ✅ Fast (no LLM call)
- ✅ Deterministic and predictable
- ✅ Easy to debug
- ✅ Low latency

**Cons:**

- ❌ Brittle (exact pattern matching)
- ❌ Requires manual rule maintenance
- ❌ Can't handle variations
- ❌ Less intelligent

### Strategy 4: Capability Matching (Recommended)

Match request to registered capabilities and choose pattern based on match quality.

```typescript
export interface CapabilityDescriptor {
  readonly id: string;
  readonly type: "workflow" | "agent";
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly examples: readonly string[];
  readonly tags: readonly string[];
  readonly priority: number;
}

export class CapabilityMatcher {
  constructor(private readonly capabilities: Ref.Ref<CapabilityDescriptor[]>) {}

  static create(): Effect.Effect<CapabilityMatcher, never> {
    return Effect.gen(function* () {
      const capabilities = yield* Ref.make<CapabilityDescriptor[]>([]);
      return new CapabilityMatcher(capabilities);
    });
  }

  registerCapability(descriptor: CapabilityDescriptor): Effect.Effect<void, never> {
    return Ref.update(this.capabilities, (caps) => [...caps, descriptor]);
  }

  match(userRequest: string): Effect.Effect<RequestIntent, Error, LLMService> {
    return Effect.gen(
      function* (this: CapabilityMatcher) {
        const capabilities = yield* Ref.get(this.capabilities);
        const llmService = yield* LLMServiceTag;

        // Use LLM to match request to capabilities (fast, focused task)
        const capabilityList = capabilities
          .map(
            (cap) =>
              `${cap.id} (${cap.type}): ${cap.description}\n  Examples: ${cap.examples.join(", ")}`,
          )
          .join("\n\n");

        const prompt = `Match this request to the best capability:

Request: "${userRequest}"

Capabilities:
${capabilityList}

Which capability best matches? Respond with ONLY the capability ID, or "NONE" if no good match.`;

        const response = yield* llmService.chat({
          messages: [{ role: "user", content: prompt }],
          provider: "openai",
          model: "gpt-4o-mini",
        });

        const matchedId = response.content.trim();

        if (matchedId === "NONE") {
          // No match, default to handoff
          return {
            intentType: "handoff",
            confidence: 60,
            reasoning: "No specific capability matched, using handoff agent",
          };
        }

        const matched = capabilities.find((cap) => cap.id === matchedId);
        if (!matched) {
          return {
            intentType: "handoff",
            confidence: 50,
            reasoning: "Invalid capability match, using handoff agent",
          };
        }

        return {
          intentType: matched.type === "workflow" ? "workflow" : "handoff",
          confidence: 85,
          reasoning: `Matched capability: ${matched.name}`,
          suggestedResource: matched.id,
        };
      }.bind(this),
    );
  }
}
```

**Pros:**

- ✅ Dynamic based on registered resources
- ✅ Semantic matching (understands intent)
- ✅ Self-organizing as you add workflows/agents
- ✅ Good balance of intelligence and simplicity

**Cons:**

- ⚠️ Still requires LLM call (but fast/cheap)
- ⚠️ Requires capability registration
- ⚠️ Medium complexity

### Strategy 5: Hybrid Approach (Best of All Worlds)

Combine multiple strategies for optimal routing.

```typescript
export class HybridRouter {
  constructor(
    private readonly ruleBasedRouter: RuleBasedRouter,
    private readonly capabilityMatcher: CapabilityMatcher,
    private readonly intentClassifier: IntentClassifier,
  ) {}

  route(
    userRequest: string,
    context?: RequestContext,
  ): Effect.Effect<RequestIntent, Error, LLMService> {
    return Effect.gen(
      function* (this: HybridRouter) {
        // Step 1: Try rule-based routing (fast)
        const ruleResult = yield* this.ruleBasedRouter.route(userRequest);

        if (ruleResult.confidence > 80) {
          // High confidence rule match, use it
          return ruleResult;
        }

        // Step 2: Try capability matching (semantic)
        const capabilityResult = yield* this.capabilityMatcher.match(userRequest);

        if (capabilityResult.confidence > 75) {
          // Good capability match, use it
          return capabilityResult;
        }

        // Step 3: Fall back to full intent classification
        const intentResult = yield* this.intentClassifier.classifyIntent(userRequest, context);

        return intentResult;
      }.bind(this),
    );
  }
}
```

## Recommended Architecture

Here's the recommended routing architecture for Jazz:

```typescript
// src/core/routing/request-router.ts

export interface RequestRouter {
  readonly route: (
    request: string,
    context?: RequestContext,
  ) => Effect.Effect<RoutingDecision, Error, LLMService>;
}

export interface RoutingDecision {
  readonly strategy: "workflow" | "handoff" | "single-agent";
  readonly confidence: number;
  readonly resourceId?: string; // workflow ID or agent ID
  readonly reasoning: string;
  readonly alternatives?: readonly RoutingAlternative[];
}

export interface RoutingAlternative {
  readonly strategy: "workflow" | "handoff" | "single-agent";
  readonly resourceId?: string;
  readonly confidence: number;
}

export class DefaultRequestRouter implements RequestRouter {
  constructor(
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly agentService: AgentService,
    private readonly capabilityMatcher: CapabilityMatcher,
  ) {}

  route(
    request: string,
    context?: RequestContext,
  ): Effect.Effect<RoutingDecision, Error, LLMService> {
    return Effect.gen(
      function* (this: DefaultRequestRouter) {
        // 1. Check for exact workflow name match
        const workflows = yield* this.workflowRegistry.listWorkflows();
        const exactWorkflowMatch = workflows.find((w) =>
          request.toLowerCase().includes(w.name.toLowerCase()),
        );

        if (exactWorkflowMatch) {
          return {
            strategy: "workflow",
            confidence: 95,
            resourceId: exactWorkflowMatch.id,
            reasoning: `Exact match for workflow: ${exactWorkflowMatch.name}`,
          };
        }

        // 2. Use capability matching for semantic search
        const capabilityResult = yield* this.capabilityMatcher.match(request);

        if (capabilityResult.confidence > 70 && capabilityResult.suggestedResource) {
          // Determine if it's a workflow or agent
          const isWorkflow = workflows.some((w) => w.id === capabilityResult.suggestedResource);

          return {
            strategy: isWorkflow ? "workflow" : "handoff",
            confidence: capabilityResult.confidence,
            resourceId: capabilityResult.suggestedResource,
            reasoning: capabilityResult.reasoning,
          };
        }

        // 3. Default to handoff with generalist agent
        const agents = yield* this.agentService.listAgents();
        const generalist = agents.find((a) => a.config.agentType === "generalist");

        return {
          strategy: "handoff",
          confidence: 60,
          resourceId: generalist?.id,
          reasoning: "No specific match found, using generalist agent with handoff capability",
          alternatives: workflows.slice(0, 3).map((w) => ({
            strategy: "workflow" as const,
            resourceId: w.id,
            confidence: 40,
          })),
        };
      }.bind(this),
    );
  }
}
```

## CLI Integration

```typescript
// src/cli/commands/jazz.ts

export function createJazzCommand(): Effect.Effect<
  void,
  Error,
  RequestRouter | WorkflowOrchestrator | AgentRunner | LLMService | LoggerService
> {
  return Effect.gen(function* () {
    const router = yield* RequestRouterTag;
    const workflowOrchestrator = yield* WorkflowOrchestratorTag;
    const logger = yield* LoggerServiceTag;

    // Get user input
    const userRequest = process.argv.slice(2).join(" ");

    if (!userRequest) {
      console.log("Usage: jazz <request>");
      return;
    }

    // Route the request
    yield* logger.info("Routing request", { request: userRequest });
    const decision = yield* router.route(userRequest);

    yield* logger.info("Routing decision", {
      strategy: decision.strategy,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
    });

    // Execute based on routing decision
    if (decision.confidence < 60 && decision.alternatives) {
      // Low confidence, ask user to clarify
      console.log("\n🤔 I'm not entirely sure how to handle this request.\n");
      console.log(`My best guess: ${decision.reasoning}\n`);
      console.log("Did you mean one of these?");
      decision.alternatives.forEach((alt, i) => {
        console.log(`  ${i + 1}. ${alt.strategy} - ${alt.resourceId}`);
      });
      // Await user selection
      // ...
    }

    switch (decision.strategy) {
      case "workflow": {
        if (!decision.resourceId) {
          return yield* Effect.fail(new Error("No workflow ID provided"));
        }
        console.log(`\n🔄 Executing workflow: ${decision.resourceId}\n`);
        const result = yield* workflowOrchestrator.execute(decision.resourceId);
        console.log("\n✅ Workflow completed!");
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case "handoff": {
        const agentId = decision.resourceId || "default-generalist";
        console.log(`\n💬 Starting conversation with agent: ${agentId}\n`);
        const agent = yield* getAgentById(agentId);
        const response = yield* AgentRunner.run({
          agent,
          userInput: userRequest,
          conversationId: `cli-${Date.now()}`,
        });
        console.log("\n" + response.response);
        break;
      }

      case "single-agent": {
        if (!decision.resourceId) {
          return yield* Effect.fail(new Error("No agent ID provided"));
        }
        console.log(`\n⚡ Running agent: ${decision.resourceId}\n`);
        const agent = yield* getAgentById(decision.resourceId);
        const response = yield* AgentRunner.run({
          agent,
          userInput: userRequest,
          conversationId: `cli-${Date.now()}`,
          maxIterations: 5, // Quick execution
        });
        console.log(response.response);
        break;
      }
    }
  });
}
```

## User Experience Examples

```bash
# Example 1: Clear workflow request
$ jazz deploy to production

🔄 Executing workflow: production-deployment
✅ Step 1: Running tests... ✓
✅ Step 2: Building artifacts... ✓
✅ Step 3: Deploying to production... ✓
✅ Workflow completed!

# Example 2: Exploratory request (handoff)
$ jazz help me investigate why the app is slow

💬 Starting conversation with agent: generalist-agent

I'll help you investigate the performance issue. Let me start by checking
a few things...

[Uses tools to check metrics]

I see high database query times. Let me hand this off to the Database
Specialist for deeper analysis...

[Handoff to DB specialist]

The issue is N+1 queries in the User model. Here's how to fix it...

# Example 3: Simple request (single agent)
$ jazz list my unread emails

⚡ Running agent: email-agent

You have 15 unread emails:
1. John Doe - "Meeting tomorrow"
2. Jane Smith - "Project update"
...

# Example 4: Ambiguous request
$ jazz run the thing

🤔 I'm not entirely sure how to handle this request.

My best guess: Using handoff agent for exploration

Did you mean one of these?
  1. workflow - ci-pipeline
  2. workflow - deployment-pipeline
  3. workflow - daily-report

Please clarify or enter a number to select:
```

## Configuration

Allow users to configure routing behavior:

```json
{
  "routing": {
    "strategy": "hybrid",
    "defaultPattern": "handoff",
    "confidenceThreshold": 70,
    "askForClarification": true,
    "preferWorkflows": true,
    "fallbackAgent": "generalist-agent"
  }
}
```

## Routing Decision Tree

```
User Request
     │
     ▼
┌─────────────────┐
│ Exact workflow  │─── Yes ──▶ Execute Workflow
│ name match?     │
└────────┬────────┘
         │ No
         ▼
┌─────────────────┐
│ Capability      │─── High ──▶ Execute Matched Resource
│ match?          │  confidence
└────────┬────────┘
         │ Medium/Low
         ▼
┌─────────────────┐
│ Ask user for    │◀─── confidence ─▶ Execute with
│ clarification?  │      < 60          Warning
└────────┬────────┘
         │ User confirms
         ▼
┌─────────────────┐
│ Default to      │
│ Handoff Agent   │
└─────────────────┘
```

## Monitoring & Learning

Track routing decisions to improve over time:

```typescript
export interface RoutingMetrics {
  readonly totalRequests: number;
  readonly routingDecisions: Record<string, number>; // strategy -> count
  readonly averageConfidence: number;
  readonly userCorrections: number; // How often users corrected routing
  readonly successRate: number;
}

export class RoutingMonitor {
  trackDecision(
    request: string,
    decision: RoutingDecision,
    userAccepted: boolean,
  ): Effect.Effect<void, never> {
    // Store decision for analysis
    // If user corrected, learn from it
  }
}
```

## Summary & Recommendation

**For Jazz, I recommend:**

1. **Start with Explicit Commands** (Phase 1)
   - `jazz chat` for handoff
   - `jazz workflow run <name>` for workflows
   - Simple and clear

2. **Add Capability Matching** (Phase 2)
   - `jazz <anything>` routes intelligently
   - Register workflows and agents with capabilities
   - Semantic matching

3. **Enhance with Hybrid** (Phase 3)
   - Combine rule-based + capability + full classification
   - Ask for clarification when confidence is low
   - Learn from user corrections

**No separate "routing agent" needed** - the routing logic is lightweight enough to be a service,
not a full agent. It uses LLM for matching but doesn't need agent-level complexity.

The key insight: **Pattern selection should be implicit and intelligent, not something users think
about.**

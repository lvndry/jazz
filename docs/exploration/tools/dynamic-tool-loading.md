# Dynamic Tool Loading & Selection

## Overview

As Jazz's tool ecosystem grows (Git, Gmail, Shell, Files, HTTP, Slack, GitHub, Calendar, etc.), manually selecting tools for each agent becomes untenable. **Dynamic tool loading** intelligently loads only the most relevant tools based on conversation context, query intent, and learned usage patterns.

## The Scalability Problem

### Current Approach (Manual Selection)
```typescript
// User must explicitly list tools
const agent = await createAgent("assistant", {
  tools: [
    "read_file", "write_file", "list_dir", "grep",
    "git_status", "git_commit", "git_push",
    "gmail_list", "gmail_send", "gmail_search",
    "execute_command", "http_request",
    // ... 50 more tools?
  ]
});

// Problems:
// 1. Too many tools = slower LLM responses (long tool descriptions)
// 2. Irrelevant tools = higher cost (unnecessary context)
// 3. User doesn't know what tools exist
// 4. Copy-paste tool lists between agents
// 5. Miss tools that would be useful
```

### Future with 200+ Tools
```
Categories:
- File System (20 tools)
- Git (15 tools)
- Gmail (25 tools)
- Calendar (15 tools)
- Slack (20 tools)
- GitHub (30 tools)
- Docker (25 tools)
- Kubernetes (30 tools)
- AWS (50+ tools)
- Database (20 tools)
...

Total: 250+ tools and growing!
```

**Challenge**: Can't include all tools in every request (token limits, performance, cost).

## Dynamic Loading Strategies

### Strategy 1: Intent-Based Selection (LLM Classifier)

Use a lightweight LLM call to classify query intent and select relevant tool categories.

```typescript
export interface ToolSelector {
  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService>;
}

export interface SelectionContext {
  readonly conversationHistory?: readonly ChatMessage[];
  readonly currentDirectory?: string;
  readonly agentId: string;
  readonly userId?: string;
  readonly previousTools?: readonly string[]; // Tools used so far
}

export class IntentBasedToolSelector implements ToolSelector {
  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService | ToolRegistry> {
    return Effect.gen(function* () {
      const llm = yield* LLMServiceTag;
      const registry = yield* ToolRegistryTag;

      // Get all available tool categories
      const categories = yield* registry.listCategories();
      const categoryDescriptions = categories
        .map((cat) => `- ${cat}: ${getCategoryDescription(cat)}`)
        .join("\n");

      const prompt = `Analyze this user query and select relevant tool categories.

Query: "${query}"

${context.currentDirectory ? `Current directory: ${context.currentDirectory}` : ""}
${context.conversationHistory ? formatRecentHistory(context.conversationHistory) : ""}

Available categories:
${categoryDescriptions}

Return JSON array of relevant categories (max 3-5):
["category1", "category2", ...]

Consider:
1. Direct mentions (e.g., "send email" → Gmail)
2. Implicit needs (e.g., "what changed?" → Git)
3. Current context (working directory, conversation flow)
`;

      const response = yield* llm.chat({
        messages: [{ role: "user", content: prompt }],
        provider: "openai",
        model: "gpt-4o-mini", // Fast, cheap for classification
      });

      const selectedCategories = JSON.parse(response.content) as string[];

      // Get tools in selected categories
      const tools: string[] = [];
      for (const category of selectedCategories) {
        const categoryTools = yield* registry.getToolsInCategory(category);
        tools.push(...categoryTools);
      }

      // Always include "core" tools (read_file, list_dir, etc.)
      const coreTools = yield* registry.getToolsInCategory("Core");
      tools.push(...coreTools);

      return Array.from(new Set(tools)); // Deduplicate
    });
  }
}
```

**Example Flow:**
```
User: "Send an email to John about the deployment"

↓ Intent Classification
Categories: ["Gmail", "Git"]  
(Email explicitly mentioned, deployment suggests Git)

↓ Load Tools
Tools: [
  "gmail_send",
  "gmail_list", 
  "gmail_search",
  "git_status",
  "git_log",
  "git_diff"
]

↓ Agent uses relevant tools
Agent: [Uses git_log to see recent deployments]
Agent: [Uses gmail_send to send email]
```

### Strategy 2: Semantic Tool Matching (Vector Search)

Use embeddings to find tools semantically similar to the query.

```typescript
export class SemanticToolSelector implements ToolSelector {
  constructor(
    private readonly vectorMemory: VectorMemoryService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async initialize(): Promise<void> {
    // Index all tools with embeddings
    const allTools = await this.toolRegistry.listTools();

    for (const toolName of allTools) {
      const tool = await this.toolRegistry.getTool(toolName);
      
      // Create rich description for embedding
      const description = `${tool.name}: ${tool.description}
Examples: ${tool.examples?.join(", ")}
Tags: ${tool.tags?.join(", ")}`;

      await this.vectorMemory.storeMemory(description, {
        type: "tool",
        toolName: tool.name,
        category: tool.category,
      });
    }
  }

  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService> {
    return Effect.gen(
      function* (this: SemanticToolSelector) {
        // Enrich query with context
        const enrichedQuery = buildEnrichedQuery(query, context);

        // Semantic search for similar tools
        const similar = yield* this.vectorMemory.searchSimilar(enrichedQuery, 15);

        // Extract tool names
        const tools = similar
          .map((entry) => entry.metadata.toolName as string)
          .filter(Boolean);

        // Always include core tools
        const coreTools = yield* this.toolRegistry.getToolsInCategory("Core");
        tools.push(...coreTools);

        return Array.from(new Set(tools));
      }.bind(this),
    );
  }
}

function buildEnrichedQuery(query: string, context: SelectionContext): string {
  const parts = [query];

  if (context.currentDirectory) {
    parts.push(`Working in: ${context.currentDirectory}`);
  }

  if (context.conversationHistory && context.conversationHistory.length > 0) {
    const recent = context.conversationHistory
      .slice(-3)
      .map((m) => m.content)
      .join(" ");
    parts.push(`Recent context: ${recent}`);
  }

  return parts.join("\n");
}
```

**Example:**
```
User: "What did I change in the last commit?"

↓ Semantic Search (finds tools about "changes", "commits", "diff")
Similar tools (by meaning):
  - git_diff (0.92 similarity)
  - git_log (0.89 similarity)
  - git_status (0.85 similarity)
  - git_show (0.82 similarity)
  - read_file (0.45 similarity)

↓ Load top matches
Tools: [git_diff, git_log, git_status, git_show]
```

### Strategy 3: Progressive Tool Loading (Lazy)

Start with minimal tools, load more as needed during conversation.

```typescript
export class ProgressiveToolLoader {
  constructor(
    private readonly initialSelector: ToolSelector,
    private readonly expansionSelector: ToolSelector,
  ) {}

  async runWithProgressiveLoading(
    agent: Agent,
    userInput: string,
    conversationHistory: ChatMessage[],
  ): Promise<AgentResponse> {
    // Phase 1: Initial tool set (small, fast)
    let currentTools = await this.initialSelector.selectTools(userInput, {
      conversationHistory,
      agentId: agent.id,
    });

    let iteration = 0;
    const maxIterations = 10;

    while (iteration < maxIterations) {
      // Run agent with current tool set
      const response = await AgentRunner.run({
        agent: { ...agent, config: { ...agent.config, tools: currentTools } },
        userInput,
        conversationHistory,
        maxIterations: 3, // Short iterations
      });

      // Check if agent needs more tools
      if (response.status === "completed") {
        return response;
      }

      // Agent couldn't complete - analyze what tools might help
      const additionalTools = await this.expansionSelector.selectTools(
        analyzeFailure(response),
        {
          conversationHistory: response.messages,
          previousTools: currentTools,
          agentId: agent.id,
        },
      );

      // Expand tool set
      currentTools = Array.from(new Set([...currentTools, ...additionalTools]));
      iteration++;
    }

    throw new Error("Could not complete task even with expanded tools");
  }
}

function analyzeFailure(response: AgentResponse): string {
  // Extract what the agent was trying to do
  const lastMessage = response.messages?.[response.messages.length - 1];
  return `Agent couldn't complete task. Last attempt: ${lastMessage?.content}`;
}
```

**Example Flow:**
```
User: "Deploy the app"

Phase 1: Initial tools (Git, Files)
Agent: [Checks git status]
Agent: "I need to run tests first"
❌ No test tools available

Phase 2: Expand tools (add Shell)
Agent: [Runs npm test]
Agent: "Tests passed, need to deploy"
❌ No deployment tools available

Phase 3: Expand tools (add Docker, Kubernetes)
Agent: [Builds Docker image]
Agent: [Deploys to Kubernetes]
✅ Success!

Final tool set: Git + Files + Shell + Docker + Kubernetes
```

### Strategy 4: Usage Pattern Learning

Learn which tools are commonly used together and predict needed tools.

```typescript
export interface ToolUsagePattern {
  readonly primaryTool: string;
  readonly frequentlyUsedWith: Record<string, number>; // tool -> co-occurrence count
  readonly contextPatterns: readonly ContextPattern[];
}

export interface ContextPattern {
  readonly context: string; // "deployment", "email", "debugging"
  readonly tools: readonly string[];
  readonly frequency: number;
}

export class UsagePatternToolSelector implements ToolSelector {
  constructor(
    private readonly patterns: Ref.Ref<Map<string, ToolUsagePattern>>,
    private readonly baseSelector: ToolSelector,
  ) {}

  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService> {
    return Effect.gen(
      function* (this: UsagePatternToolSelector) {
        // Get base tool selection
        const baseTools = yield* this.baseSelector.selectTools(query, context);

        // Get usage patterns
        const patterns = yield* Ref.get(this.patterns);

        // Expand based on co-occurrence
        const expandedTools = new Set(baseTools);

        for (const tool of baseTools) {
          const pattern = patterns.get(tool);
          if (pattern) {
            // Add frequently co-used tools
            const coUsed = Object.entries(pattern.frequentlyUsedWith)
              .filter(([_, count]) => count > 5) // Used together 5+ times
              .map(([toolName]) => toolName);

            coUsed.forEach((t) => expandedTools.add(t));
          }
        }

        return Array.from(expandedTools);
      }.bind(this),
    );
  }

  // Learn from execution
  recordUsage(tools: readonly string[], context: string): Effect.Effect<void, never> {
    return Effect.gen(
      function* (this: UsagePatternToolSelector) {
        yield* Ref.update(this.patterns, (patterns) => {
          const newPatterns = new Map(patterns);

          // Update co-occurrence for each pair
          for (const tool1 of tools) {
            let pattern = newPatterns.get(tool1);
            if (!pattern) {
              pattern = {
                primaryTool: tool1,
                frequentlyUsedWith: {},
                contextPatterns: [],
              };
            }

            for (const tool2 of tools) {
              if (tool1 !== tool2) {
                const count = pattern.frequentlyUsedWith[tool2] || 0;
                pattern = {
                  ...pattern,
                  frequentlyUsedWith: {
                    ...pattern.frequentlyUsedWith,
                    [tool2]: count + 1,
                  },
                };
              }
            }

            newPatterns.set(tool1, pattern);
          }

          return newPatterns;
        });
      }.bind(this),
    );
  }
}
```

**Learning Example:**
```
After 10 conversations:

git_commit frequently used with:
  - git_status (9 times)
  - git_diff (8 times)
  - git_push (7 times)
  - read_file (6 times)

send_email frequently used with:
  - list_emails (10 times)
  - search_emails (8 times)
  - read_file (7 times)
  - http_request (3 times)

↓ Next time user says "commit my changes"
Auto-include: git_commit, git_status, git_diff, git_push
```

### Strategy 5: Tool Dependency Graph

Tools declare dependencies, automatically load required tools.

```typescript
export interface ToolDefinitionWithDeps extends Tool {
  readonly dependencies?: readonly ToolDependency[];
}

export interface ToolDependency {
  readonly type: "required" | "optional" | "suggested";
  readonly toolName: string;
  readonly reason: string;
}

export class DependencyAwareToolSelector implements ToolSelector {
  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService | ToolRegistry> {
    return Effect.gen(function* () {
      const registry = yield* ToolRegistryTag;
      const baseSelector = yield* IntentBasedToolSelector;

      // Get initial tool selection
      const initialTools = yield* baseSelector.selectTools(query, context);

      // Recursively add dependencies
      const allTools = new Set<string>();
      const queue = [...initialTools];

      while (queue.length > 0) {
        const toolName = queue.shift()!;
        if (allTools.has(toolName)) continue;

        allTools.add(toolName);

        const tool = yield* registry.getTool(toolName);
        if (tool.dependencies) {
          for (const dep of tool.dependencies) {
            if (dep.type === "required" && !allTools.has(dep.toolName)) {
              queue.push(dep.toolName);
            }
          }
        }
      }

      return Array.from(allTools);
    });
  }
}

// Example tool definitions
const gitCommitTool = defineTool({
  name: "git_commit",
  description: "Commit staged changes",
  dependencies: [
    { type: "required", toolName: "git_status", reason: "Need to check status first" },
    { type: "suggested", toolName: "git_diff", reason: "Review changes before commit" },
  ],
  // ...
});

const deployTool = defineTool({
  name: "deploy_production",
  description: "Deploy to production",
  dependencies: [
    { type: "required", toolName: "execute_command", reason: "Need to run deployment commands" },
    { type: "required", toolName: "git_status", reason: "Verify clean working tree" },
    { type: "suggested", toolName: "read_file", reason: "May need to read configs" },
  ],
  // ...
});
```

**Example:**
```
User wants: deploy_production

↓ Check dependencies
deploy_production requires:
  - execute_command (required)
  - git_status (required)
  - read_file (suggested)

git_status requires:
  - pwd (required)

↓ Final tool set
Tools: [
  deploy_production,
  execute_command,
  git_status,
  pwd,
  read_file  // included as suggested
]
```

### Strategy 6: Hierarchical Tool Organization

Organize tools in hierarchy, load category when any tool needed.

```typescript
export interface ToolHierarchy {
  readonly categories: readonly ToolCategory[];
}

export interface ToolCategory {
  readonly name: string;
  readonly description: string;
  readonly coreFools: readonly string[]; // Always include
  readonly standardTools: readonly string[]; // Include if category selected
  readonly advancedTools: readonly string[]; // Include if explicitly needed
  readonly subCategories?: readonly ToolCategory[];
}

const toolHierarchy: ToolHierarchy = {
  categories: [
    {
      name: "Git",
      description: "Version control operations",
      coreTools: ["git_status", "git_log"],
      standardTools: ["git_diff", "git_commit", "git_push", "git_pull"],
      advancedTools: ["git_rebase", "git_cherry_pick", "git_bisect"],
      subCategories: [
        {
          name: "Git:Branches",
          description: "Branch management",
          coreTools: ["git_branch"],
          standardTools: ["git_checkout", "git_merge"],
          advancedTools: ["git_rebase"],
        },
      ],
    },
    {
      name: "Email",
      description: "Email operations",
      coreTools: ["gmail_list", "gmail_read"],
      standardTools: ["gmail_send", "gmail_search", "gmail_delete"],
      advancedTools: ["gmail_batch_modify", "gmail_create_filter"],
    },
  ],
};

export class HierarchicalToolSelector implements ToolSelector {
  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService> {
    return Effect.gen(function* () {
      // Classify to categories
      const categories = yield* classifyToCategories(query, toolHierarchy);

      const tools: string[] = [];

      for (const category of categories) {
        // Always include core tools
        tools.push(...category.coreTools);

        // Include standard tools
        tools.push(...category.standardTools);

        // Conditionally include advanced tools
        if (needsAdvancedTools(query, category)) {
          tools.push(...category.advancedTools);
        }

        // Check sub-categories
        if (category.subCategories) {
          const subCats = yield* classifyToCategories(query, {
            categories: category.subCategories,
          });
          for (const subCat of subCats) {
            tools.push(...subCat.coreTools);
            tools.push(...subCat.standardTools);
          }
        }
      }

      return Array.from(new Set(tools));
    });
  }
}
```

### Strategy 7: Adaptive Tool Budget

Intelligently manage token budget by prioritizing most relevant tools.

```typescript
export interface ToolBudget {
  readonly maxTools: number;
  readonly maxTokens: number;
  readonly prioritization: "relevance" | "frequency" | "hybrid";
}

export class BudgetAwareToolSelector implements ToolSelector {
  selectTools(
    query: string,
    context: SelectionContext,
    budget: ToolBudget = { maxTools: 20, maxTokens: 4000, prioritization: "hybrid" },
  ): Effect.Effect<readonly string[], Error, LLMService> {
    return Effect.gen(function* () {
      // Get candidate tools (more than budget allows)
      const candidates = yield* getAllCandidateTools(query, context);

      // Score each tool
      const scoredTools = yield* Promise.all(
        candidates.map(async (toolName) => {
          const relevance = await calculateRelevance(toolName, query);
          const frequency = await getUsageFrequency(toolName, context);
          const tokenCost = await estimateTokenCost(toolName);

          return {
            toolName,
            score:
              budget.prioritization === "relevance"
                ? relevance
                : budget.prioritization === "frequency"
                  ? frequency
                  : relevance * 0.7 + frequency * 0.3,
            tokenCost,
          };
        }),
      );

      // Sort by score
      scoredTools.sort((a, b) => b.score - a.score);

      // Fit within budget
      const selected: string[] = [];
      let tokenCount = 0;

      for (const tool of scoredTools) {
        if (selected.length >= budget.maxTools) break;
        if (tokenCount + tool.tokenCost > budget.maxTokens) break;

        selected.push(tool.toolName);
        tokenCount += tool.tokenCost;
      }

      return selected;
    });
  }
}
```

## Hybrid Approach (Recommended)

Combine multiple strategies for optimal results:

```typescript
export class HybridToolSelector implements ToolSelector {
  constructor(
    private readonly intentSelector: IntentBasedToolSelector,
    private readonly semanticSelector: SemanticToolSelector,
    private readonly patternSelector: UsagePatternToolSelector,
    private readonly dependencySelector: DependencyAwareToolSelector,
  ) {}

  selectTools(
    query: string,
    context: SelectionContext,
  ): Effect.Effect<readonly string[], Error, LLMService> {
    return Effect.gen(
      function* (this: HybridToolSelector) {
        // 1. Intent-based selection (fast, categorical)
        const intentTools = yield* this.intentSelector.selectTools(query, context);

        // 2. Semantic matching (finds nuanced tools)
        const semanticTools = yield* this.semanticSelector.selectTools(query, context);

        // 3. Usage pattern expansion (learn from history)
        const patternTools = yield* this.patternSelector.selectTools(query, context);

        // 4. Add dependencies
        const allCandidates = Array.from(
          new Set([...intentTools, ...semanticTools, ...patternTools]),
        );

        const withDeps = yield* this.dependencySelector.selectTools(
          query,
          { ...context, previousTools: allCandidates },
        );

        // 5. Apply budget constraints
        const budgeted = yield* applyBudget(withDeps, {
          maxTools: 25,
          maxTokens: 5000,
          prioritization: "hybrid",
        });

        return budgeted;
      }.bind(this),
    );
  }
}
```

## Tool Metadata for Better Selection

Enrich tool definitions to enable smart selection:

```typescript
export interface EnhancedToolDefinition extends Tool {
  // Categorization
  readonly category: string;
  readonly subcategory?: string;
  readonly tags: readonly string[];

  // Semantic
  readonly aliases: readonly string[]; // Alternative names
  readonly keywords: readonly string[]; // Search keywords
  readonly examples: readonly string[]; // Usage examples

  // Dependencies
  readonly dependencies?: readonly ToolDependency[];
  readonly suggestedWith?: readonly string[]; // Tools often used together

  // Constraints
  readonly requiredPermissions?: readonly string[];
  readonly platformSupport?: readonly ("mac" | "linux" | "windows")[];

  // Metadata
  readonly complexity: "simple" | "moderate" | "complex";
  readonly estimatedTokenCost: number;
  readonly usageFrequency?: number; // Auto-updated
}
```

## Configuration & User Control

```yaml
# ~/.jazz/config.yaml
tool_selection:
  mode: "dynamic" # or "manual" or "hybrid"

  dynamic_config:
    strategy: "hybrid" # intent, semantic, pattern, hybrid
    max_tools: 25
    max_tokens: 5000
    
    # Always include these
    core_tools:
      - read_file
      - write_file
      - list_dir
      - pwd
    
    # Never auto-include these (too risky)
    exclude_tools:
      - delete_database
      - format_disk
    
    # Category preferences
    prefer_categories:
      - "Git"
      - "Files"
    
    # Learning
    learn_from_usage: true
    pattern_threshold: 5 # Co-occurrence needed to learn pattern

  # Fallback to manual for specific agents
  manual_agents:
    - "production-deploy-agent" # Too critical for dynamic
```

## CLI Commands

```bash
# View current tool selection for a query
$ jazz tools preview "Deploy the app"

🔍 Tool Selection Preview:
Query: "Deploy the app"

Selected tools (18):
  Git (5 tools)
    • git_status
    • git_log
    • git_diff
    • git_commit
    • git_push
    
  Docker (4 tools)
    • docker_build
    • docker_push
    • docker_run
    • docker_ps
    
  Kubernetes (6 tools)
    • kubectl_apply
    • kubectl_get
    • kubectl_logs
    • kubectl_describe
    • kubectl_rollout
    • kubectl_scale
    
  Core (3 tools)
    • read_file
    • execute_command
    • http_request

Total token cost: ~3,200 tokens

# Analyze tool usage patterns
$ jazz tools analyze

📊 Tool Usage Patterns:

Most used tools:
  1. read_file (245 times)
  2. git_status (189 times)
  3. list_dir (167 times)

Common combinations:
  • git_status + git_diff + git_commit (45 times)
  • gmail_list + gmail_read + gmail_send (38 times)
  • read_file + write_file + execute_command (32 times)

Underused tools:
  • git_bisect (0 times)
  • gmail_create_filter (1 time)

# Test tool selection
$ jazz tools test --query "Send email about deployment"

Testing tool selection...

Intent-based: [Gmail, Git]
Semantic match: [gmail_send, git_log, git_status]
Pattern-based: [gmail_list, gmail_search, read_file]
With dependencies: [gmail_send, git_log, git_status, gmail_list, pwd]

Final selection: 5 tools
Estimated tokens: 1,200
```

## Advanced: Tool Composition

Some "tools" are actually compositions of multiple tools:

```typescript
export interface CompositeToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly composedOf: readonly ToolComposition[];
  readonly when: string; // When to use this composition
}

export interface ToolComposition {
  readonly tool: string;
  readonly order: number;
  readonly optional: boolean;
}

const deployWorkflow: CompositeToolDefinition = {
  name: "deploy_workflow",
  description: "Complete deployment workflow",
  when: "User wants to deploy application",
  composedOf: [
    { tool: "git_status", order: 1, optional: false },
    { tool: "execute_command", order: 2, optional: false }, // npm test
    { tool: "docker_build", order: 3, optional: false },
    { tool: "docker_push", order: 4, optional: false },
    { tool: "kubectl_apply", order: 5, optional: false },
    { tool: "send_email", order: 6, optional: true }, // Notification
  ],
};
```

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Tool metadata enrichment (categories, tags, keywords)
- [ ] Tool registry with categorization
- [ ] Intent-based selector (LLM classifier)
- [ ] Core tool budget system

### Phase 2: Intelligence (Week 3-4)
- [ ] Semantic tool indexing (embeddings)
- [ ] Semantic selector implementation
- [ ] Usage pattern tracking
- [ ] Pattern-based selector

### Phase 3: Advanced (Week 5-6)
- [ ] Tool dependency graph
- [ ] Progressive loading
- [ ] Hierarchical organization
- [ ] Hybrid selector

### Phase 4: Polish (Week 7+)
- [ ] CLI tools for analysis
- [ ] Configuration system
- [ ] Learning & optimization
- [ ] Performance monitoring

## Benefits & Trade-offs

### Benefits
✅ **Scalability**: Works with 10 or 1000 tools
✅ **Performance**: Only relevant tools loaded (fewer tokens)
✅ **Cost**: Lower API costs (smaller contexts)
✅ **UX**: Users don't need to know all tools
✅ **Flexibility**: Tools added automatically as ecosystem grows
✅ **Learning**: Gets smarter over time

### Trade-offs
⚠️ **Complexity**: More sophisticated system
⚠️ **Latency**: Extra LLM call for selection (~200ms)
⚠️ **Errors**: Might miss needed tools occasionally
⚠️ **Debugging**: Harder to understand why tools were selected
⚠️ **Determinism**: Less predictable tool sets

## Mitigation Strategies

**For Latency:**
- Cache tool selections for similar queries
- Use fast models (gpt-4o-mini) for classification
- Progressive loading as fallback

**For Errors:**
- Always include "core" tools
- Allow manual override (`--tools git_*`)
- Learn from failures

**For Debugging:**
- Log tool selection reasoning
- Provide `jazz tools explain` command
- Show selection in verbose mode

## Summary

**Start with**: Intent-based selection (simple, effective)

**Evolve to**: Hybrid approach (intent + semantic + patterns)

**Key principle**: **"Start narrow, expand as needed"**

This enables Jazz to scale from 20 tools to 500+ tools without overwhelming users or LLMs! 🚀


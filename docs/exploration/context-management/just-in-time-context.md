# Just-In-Time Context Strategy

## Overview

**Just-in-time (JIT) context** is a paradigm shift in how AI agents manage information. Instead of pre-loading all potentially relevant data into the context window before reasoning, agents maintain lightweight **references** (file paths, query strings, URLs, etc.) and dynamically load data only when needed during execution.

This approach mirrors human cognition: we don't memorize entire databases, but rather use external systems (file systems, search engines, bookmarks) to retrieve information on demand.

## The Evolution: From Pre-Processing to On-Demand

### Traditional Approach: Embedding-Based Pre-Inference Retrieval

**How it works:**

1. **Pre-processing**: Before the agent reasons, retrieve relevant documents using embeddings
2. **Context loading**: Load all retrieved content into the context window
3. **Reasoning**: Agent reasons over the full context

```typescript
// Traditional RAG approach
async function traditionalRAG(query: string) {
  // Step 1: Pre-retrieve (before LLM call)
  const relevantDocs = await vectorDB.search(query, { limit: 10 });

  // Step 2: Load everything into context
  const context = relevantDocs.map((doc) => doc.content).join("\n\n");

  // Step 3: Send to LLM with full context
  const response = await llm.chat({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: `Context:\n${context}\n\nQuestion: ${query}` },
    ],
  });

  return response;
}
```

**Problems:**

- ❌ **Token waste**: Loads entire documents even if only a small portion is needed
- ❌ **Context bloat**: Fills context window with potentially irrelevant information
- ❌ **Cost**: Paying for tokens that may never be used
- ❌ **Rigidity**: Can't adapt retrieval based on intermediate reasoning
- ❌ **Scale limits**: Can't handle very large datasets (entire codebases, databases)

### Just-In-Time Approach: Dynamic Runtime Loading

**How it works:**

1. **Reference storage**: Store lightweight identifiers (paths, queries, URLs)
2. **Reasoning first**: Agent reasons about what it needs
3. **On-demand loading**: Use tools to load specific data when needed
4. **Iterative refinement**: Load more data based on what was learned

```typescript
// Just-in-time approach
async function justInTimeContext(query: string) {
  // Step 1: Agent reasons about what it needs
  const response = await llm.chat({
    messages: [
      { role: "system", content: "You have access to tools to load data on demand." },
      { role: "user", content: query },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a specific file by path",
        parameters: { path: "string" },
      },
      {
        name: "query_database",
        description: "Execute a SQL query",
        parameters: { query: "string" },
      },
      {
        name: "head_file",
        description: "Read first N lines of a file",
        parameters: { path: "string", lines: "number" },
      },
    ],
  });

  // Step 2: Agent decides what to load based on reasoning
  // Agent might call: read_file("src/utils/helpers.ts")
  // Then based on what it finds, call: query_database("SELECT * FROM users WHERE id = 123")
  // Then call: head_file("logs/app.log", 50)

  // Step 3: Agent loads only what's needed, when needed
  return response;
}
```

**Benefits:**

- ✅ **Token efficiency**: Only load what's actually needed
- ✅ **Adaptive**: Can refine queries based on intermediate results
- ✅ **Scalable**: Can work with datasets larger than context windows
- ✅ **Cost-effective**: Pay only for data actually used
- ✅ **Flexible**: Can combine multiple data sources dynamically

## Real-World Example: Claude Code

Anthropic's Claude Code demonstrates JIT context beautifully:

**Scenario**: Analyze a large database

**Traditional approach:**

```python
# Load entire database into context (impossible for large DBs)
context = load_entire_database()  # 10GB of data? No way!
analyze(context)
```

**JIT approach:**

```python
# Agent maintains references and loads on demand
agent.reason("I need to analyze user behavior")

# Agent writes targeted query
agent.call_tool("execute_query", {
  "query": "SELECT COUNT(*) FROM users WHERE created_at > '2024-01-01'"
})

# Agent analyzes result, writes another query
agent.call_tool("execute_query", {
  "query": "SELECT * FROM users WHERE id IN (SELECT user_id FROM orders GROUP BY user_id HAVING COUNT(*) > 10) LIMIT 100"
})

# Agent uses shell tools for further analysis
agent.call_tool("shell", {
  "command": "head -n 20 /data/export.csv | tail -n 10"
})
```

**Key insight**: The agent never loads the full database. It:

1. Maintains a reference to the database connection
2. Writes targeted queries based on reasoning
3. Uses tools like `head` and `tail` to sample large files
4. Loads only the specific data needed for the current reasoning step

## How JIT Context Applies to Jazz

Jazz is perfectly positioned to implement JIT context because it already has:

- ✅ **Rich tool ecosystem**: File operations, Git, Gmail, Shell, HTTP
- ✅ **Tool-based architecture**: Agents already use tools dynamically
- ✅ **Context management**: Working directory tracking, conversation history
- ✅ **Approval system**: Can safely load sensitive data on demand

### Current State: Pre-Loading Context

Currently, Jazz agents work like this:

```typescript
// Current approach: Load conversation history upfront
const messages = buildAgentMessages({
  conversationHistory: fullHistory, // All messages loaded
  userInput: "What files did I modify yesterday?",
  // ... other context
});

// Agent receives full history in context
const response = await llm.chat({ messages, tools });
```

**Limitations:**

- Full conversation history loaded even if only recent messages matter
- Tool results stored in context even if they're large
- Can't reference external files without loading them first
- Can't query databases or APIs without pre-fetching

### Future State: Just-In-Time Context

With JIT context, Jazz agents would work like this:

```typescript
// JIT approach: Store references, load on demand
const contextReferences = {
  conversationId: "conv-123",
  workingDirectory: "/Users/alice/projects/jazz",
  recentFiles: ["src/core/agent.ts", "src/services/llm.ts"],
  databaseQueries: ["SELECT * FROM tasks WHERE status = 'pending'"],
  webLinks: ["https://docs.example.com/api"],
};

// Agent receives lightweight references
const messages = buildAgentMessages({
  contextReferences, // Just references, not full data
  userInput: "What files did I modify yesterday?",
});

// Agent decides what to load
const response = await llm.chat({
  messages,
  tools: [
    "read_file", // Load specific files
    "git_log", // Query git history
    "query_memory", // Query conversation memory
    "execute_sql", // Query database
    // ... other tools
  ],
});

// Agent calls tools to load data as needed
// Tool: git_log({ since: "yesterday" })
// Tool: read_file({ path: "src/core/agent.ts" })
// Tool: query_memory({ query: "files modified", conversationId: "conv-123" })
```

## Implementation Strategy for Jazz

### Phase 1: Context Reference System

Create a system to store and manage lightweight context references.

```typescript
// src/core/agent/context-references.ts

export interface ContextReference {
  readonly type: "file" | "conversation" | "query" | "url" | "memory" | "tool_result";
  readonly identifier: string; // Path, ID, query string, URL, etc.
  readonly metadata?: {
    readonly description?: string;
    readonly timestamp?: Date;
    readonly tags?: readonly string[];
    readonly size?: number; // Estimated size if known
  };
}

export interface ContextReferenceManager {
  /**
   * Store a reference without loading the actual data
   */
  storeReference(ref: ContextReference): Effect.Effect<void, Error>;

  /**
   * Get references matching criteria
   */
  getReferences(filters: {
    type?: ContextReference["type"];
    tags?: readonly string[];
    since?: Date;
  }): Effect.Effect<readonly ContextReference[], Error>;

  /**
   * Load actual data from a reference (JIT loading)
   */
  loadReference(ref: ContextReference): Effect.Effect<string, Error, ToolRegistry>;

  /**
   * Resolve reference to actual content when needed
   */
  resolveReference(
    ref: ContextReference,
    context: ToolExecutionContext,
  ): Effect.Effect<unknown, Error, ToolRegistry>;
}
```

**Example usage:**

```typescript
// Store references instead of full data
const refs = [
  {
    type: "file",
    identifier: "src/core/agent.ts",
    metadata: { description: "Main agent implementation", size: 50000 },
  },
  {
    type: "conversation",
    identifier: "conv-123",
    metadata: { description: "Previous conversation about file operations" },
  },
  {
    type: "query",
    identifier: "SELECT * FROM tasks WHERE status = 'pending'",
    metadata: { description: "Pending tasks query" },
  },
];

// Agent receives references in context
const contextMessage = {
  role: "system",
  content: `Available context references:
- File: src/core/agent.ts (50KB)
- Conversation: conv-123 (previous discussion about files)
- Query: SELECT * FROM tasks WHERE status = 'pending'

Use tools to load these references when needed.`,
};
```

### Phase 2: Smart Context Loading Tools

Create tools that enable agents to load context on demand.

```typescript
// src/core/agent/tools/context-loader.ts

export const load_context_reference = defineTool({
  name: "load_context_reference",
  description:
    "Load data from a context reference. Use this to access files, conversations, queries, or URLs that were referenced but not yet loaded.",
  parameters: Schema.struct({
    reference_id: Schema.string,
    preview_only: Schema.optional(Schema.boolean), // Load preview/summary only
    max_size: Schema.optional(Schema.number), // Limit size for large files
  }),
  execute: (args, context) => {
    return Effect.gen(function* () {
      const refManager = yield* ContextReferenceManagerTag;
      const ref = yield* refManager.getReference(args.reference_id);

      if (!ref) {
        return { content: `Reference ${args.reference_id} not found` };
      }

      // Load based on type
      switch (ref.type) {
        case "file":
          if (args.preview_only) {
            // Use head/tail for large files
            return yield* executeTool(
              "head_file",
              {
                path: ref.identifier,
                lines: 50,
              },
              context,
            );
          }
          return yield* executeTool("read_file", { path: ref.identifier }, context);

        case "conversation":
          return yield* executeTool(
            "get_conversation",
            {
              conversationId: ref.identifier,
              summary_only: args.preview_only,
            },
            context,
          );

        case "query":
          return yield* executeTool(
            "execute_sql",
            {
              query: ref.identifier,
              limit: args.max_size || 100,
            },
            context,
          );

        case "url":
          return yield* executeTool(
            "http_request",
            {
              url: ref.identifier,
              method: "GET",
            },
            context,
          );

        default:
          return { content: `Unknown reference type: ${ref.type}` };
      }
    });
  },
});
```

### Phase 3: Reference-Aware Prompt Building

Modify prompt building to include references instead of full context.

```typescript
// src/core/agent/agent-prompt.ts (enhanced)

export class AgentPromptBuilder {
  // ... existing code ...

  /**
   * Build messages with JIT context references
   */
  buildAgentMessagesWithReferences(
    templateName: string,
    options: AgentPromptOptions & {
      contextReferences?: readonly ContextReference[];
    },
  ): Effect.Effect<ChatMessage[], Error> {
    return Effect.gen(function* () {
      const systemPrompt = yield* this.buildSystemPrompt(templateName, options);

      // Build context references message
      const referencesMessage = options.contextReferences
        ? this.buildReferencesMessage(options.contextReferences)
        : null;

      const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

      // Add references if available
      if (referencesMessage) {
        messages.push(referencesMessage);
      }

      // Add recent conversation (last N messages, not full history)
      const recentHistory = options.conversationHistory
        ? options.conversationHistory.slice(-10) // Only last 10 messages
        : [];

      messages.push(...recentHistory);

      // Add current user input
      const userPrompt = yield* this.buildUserPrompt(templateName, options);
      if (userPrompt && userPrompt.trim().length > 0) {
        messages.push({ role: "user", content: userPrompt });
      }

      return messages;
    });
  }

  private buildReferencesMessage(refs: readonly ContextReference[]): ChatMessage {
    const refDescriptions = refs
      .map((ref) => {
        const size = ref.metadata?.size ? ` (${formatBytes(ref.metadata.size)})` : "";
        const desc = ref.metadata?.description ? ` - ${ref.metadata.description}` : "";
        return `- ${ref.type}: ${ref.identifier}${size}${desc}`;
      })
      .join("\n");

    return {
      role: "system",
      content: `Available context references (use load_context_reference tool to access):
${refDescriptions}

These references are not loaded into context yet. Use the load_context_reference tool when you need to access them.`,
    };
  }
}
```

### Phase 4: Intelligent Reference Generation

Automatically generate references from conversation history and tool results.

```typescript
// src/core/agent/context-reference-generator.ts

export class ContextReferenceGenerator {
  /**
   * Extract references from conversation history
   */
  extractReferences(
    messages: readonly ChatMessage[],
  ): Effect.Effect<readonly ContextReference[], Error> {
    return Effect.gen(function* () {
      const refs: ContextReference[] = [];

      for (const msg of messages) {
        // Extract file paths mentioned
        const filePaths = this.extractFilePaths(msg.content);
        for (const path of filePaths) {
          refs.push({
            type: "file",
            identifier: path,
            metadata: {
              description: `Mentioned in conversation`,
              timestamp: new Date(),
            },
          });
        }

        // Extract URLs
        const urls = this.extractUrls(msg.content);
        for (const url of urls) {
          refs.push({
            type: "url",
            identifier: url,
            metadata: {
              description: `Referenced in conversation`,
              timestamp: new Date(),
            },
          });
        }

        // Extract tool results that are large
        if (msg.role === "tool" && msg.content.length > 5000) {
          refs.push({
            type: "tool_result",
            identifier: msg.tool_call_id || `tool-${Date.now()}`,
            metadata: {
              description: `Large tool result (${msg.content.length} chars)`,
              size: msg.content.length,
              timestamp: new Date(),
            },
          });
        }
      }

      return refs;
    });
  }

  /**
   * Create reference for large tool result instead of including in context
   */
  createToolResultReference(
    toolCallId: string,
    result: ToolExecutionResult,
    maxSize: number = 5000,
  ): ContextReference | null {
    if (result.content && result.content.length > maxSize) {
      return {
        type: "tool_result",
        identifier: toolCallId,
        metadata: {
          description: `Tool result (${result.content.length} chars)`,
          size: result.content.length,
          timestamp: new Date(),
        },
      };
    }
    return null;
  }

  private extractFilePaths(content: string): readonly string[] {
    // Match common file path patterns
    const patterns = [
      /(?:^|\s)([\/~]?[\w\/\-\.]+\.(ts|js|tsx|jsx|json|md|txt|py|go|rs|java|rb))/g,
      /(?:file|path|read|write|open):\s*([\/~]?[\w\/\-\.]+)/gi,
    ];

    const paths = new Set<string>();
    for (const pattern of patterns) {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        paths.add(match[1]);
      }
    }

    return Array.from(paths);
  }

  private extractUrls(content: string): readonly string[] {
    const urlPattern = /https?:\/\/[^\s]+/g;
    return Array.from(content.matchAll(urlPattern)).map((m) => m[0]);
  }
}
```

## Concrete Examples for Jazz

### Example 1: Large File Analysis

**Scenario**: Agent needs to analyze a 10MB log file

**Traditional approach:**

```typescript
// ❌ Loads entire file into context (impossible for 10MB)
const logContent = readFileSync("logs/app.log"); // 10MB!
const response = await llm.chat({
  messages: [{ role: "user", content: `Analyze this log:\n${logContent}` }],
});
// Fails: Context window too small
```

**JIT approach:**

```typescript
// ✅ Store reference, load on demand
const ref = {
  type: "file",
  identifier: "logs/app.log",
  metadata: { size: 10_000_000, description: "Application log file" },
};

const response = await llm.chat({
  messages: [
    {
      role: "system",
      content: `Available: log file at logs/app.log (10MB). Use tools to analyze it.`,
    },
    { role: "user", content: "Find all errors from the last hour" },
  ],
  tools: ["head_file", "tail_file", "grep_file", "execute_command"],
});

// Agent calls tools:
// 1. tail_file("logs/app.log", 1000) - Get recent entries
// 2. execute_command("grep -i error logs/app.log | tail -100") - Find errors
// 3. head_file("logs/app.log", 50) - Check file structure
// Never loads the full 10MB file!
```

### Example 2: Database Query Refinement

**Scenario**: Agent needs to analyze user behavior from database

**Traditional approach:**

```typescript
// ❌ Pre-fetch all data (inefficient, may be too large)
const allUsers = await db.query("SELECT * FROM users"); // 1M rows?
const allOrders = await db.query("SELECT * FROM orders"); // 10M rows?
// Context window explodes!
```

**JIT approach:**

```typescript
// ✅ Store query references, execute on demand
const refs = [
  {
    type: "query",
    identifier: "SELECT COUNT(*) FROM users",
    metadata: { description: "Total user count" },
  },
  {
    type: "query",
    identifier: "SELECT * FROM users WHERE created_at > '2024-01-01' LIMIT 100",
    metadata: { description: "Recent users sample" },
  },
];

const response = await llm.chat({
  messages: [
    {
      role: "system",
      content: `Available queries. Use execute_sql tool to run them.`,
    },
    { role: "user", content: "Analyze user growth trends" },
  ],
  tools: ["execute_sql", "read_file", "execute_command"],
});

// Agent iteratively:
// 1. execute_sql("SELECT COUNT(*) FROM users WHERE created_at > '2024-01-01'")
// 2. Based on result, execute_sql("SELECT DATE(created_at), COUNT(*) FROM users GROUP BY DATE(created_at)")
// 3. Refines query based on what it learns
// Only loads data it actually needs!
```

### Example 3: Multi-Conversation Context

**Scenario**: Agent needs context from previous conversations

**Traditional approach:**

```typescript
// ❌ Load all previous conversations (token explosion)
const allConversations = await loadAllConversations(agentId);
const fullHistory = allConversations.flatMap((c) => c.messages);
// 50,000 messages? Context window can't handle it!
```

**JIT approach:**

```typescript
// ✅ Store conversation references, load summaries on demand
const refs = [
  {
    type: "conversation",
    identifier: "conv-123",
    metadata: { description: "Previous discussion about file operations", timestamp: yesterday },
  },
  {
    type: "conversation",
    identifier: "conv-456",
    metadata: { description: "Git workflow discussion", timestamp: lastWeek },
  },
];

const response = await llm.chat({
  messages: [
    {
      role: "system",
      content: `Previous conversations available. Use get_conversation tool to access them.`,
    },
    { role: "user", content: "What did we decide about file operations?" },
  ],
  tools: ["get_conversation", "search_conversations"],
});

// Agent calls:
// 1. get_conversation("conv-123", { summary_only: true }) - Get summary first
// 2. Based on summary, get_conversation("conv-123", { message_ids: [5, 10, 15] }) - Get specific messages
// Only loads what's relevant!
```

### Example 4: Web Research with JIT Loading

**Scenario**: Agent needs to research a topic using web search

**Traditional approach:**

```typescript
// ❌ Pre-fetch all search results
const results = await webSearch("TypeScript best practices");
const allContent = results.map((r) => r.content).join("\n\n"); // 50KB of content
// Most may be irrelevant!
```

**JIT approach:**

```typescript
// ✅ Store search result references, load on demand
const searchRefs = [
  {
    type: "url",
    identifier: "https://www.typescriptlang.org/docs/handbook/",
    metadata: { description: "TypeScript official docs" },
  },
  {
    type: "url",
    identifier: "https://github.com/microsoft/TypeScript/wiki/",
    metadata: { description: "TypeScript GitHub wiki" },
  },
];

const response = await llm.chat({
  messages: [
    {
      role: "system",
      content: `Search results available. Use load_url tool to access them.`,
    },
    { role: "user", content: "What are TypeScript best practices?" },
  ],
  tools: ["load_url", "web_search", "read_file"],
});

// Agent:
// 1. load_url("https://www.typescriptlang.org/docs/handbook/") - Load official docs
// 2. Based on content, load_url("https://github.com/microsoft/TypeScript/wiki/Best-practices") - Load specific page
// 3. Only loads pages it actually needs!
```

## Benefits for Jazz

### 1. **Token Efficiency**

- **Before**: Loading 50KB of conversation history + 20KB of tool results = 70KB in context
- **After**: 2KB of references + load 5KB when needed = 7KB total (90% reduction)

### 2. **Scalability**

- **Before**: Can't handle conversations > 100 messages or files > 1MB
- **After**: Can reference unlimited conversations and files, load on demand

### 3. **Cost Reduction**

- **Before**: Paying for 70KB of context every LLM call
- **After**: Paying for 7KB of context + 5KB loaded data = 12KB (83% cost reduction)

### 4. **Adaptive Reasoning**

- **Before**: Agent must work with pre-loaded context
- **After**: Agent can refine queries based on intermediate results

### 5. **Better Tool Integration**

- **Before**: Tools return data that must fit in context
- **After**: Tools can return references to large results, load on demand

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

- [ ] Create `ContextReference` type and `ContextReferenceManager`
- [ ] Implement basic reference storage (in-memory, then persistent)
- [ ] Create `load_context_reference` tool
- [ ] Modify prompt builder to include references

### Phase 2: Smart Extraction (Week 3)

- [ ] Implement `ContextReferenceGenerator` to extract references from conversations
- [ ] Auto-generate references for large tool results
- [ ] Extract file paths, URLs, queries from messages

### Phase 3: Integration (Week 4)

- [ ] Integrate with existing tools (file operations, Git, etc.)
- [ ] Add reference support to conversation history
- [ ] Update agent prompts to use references

### Phase 4: Optimization (Week 5+)

- [ ] Implement reference caching
- [ ] Add reference summarization for very large data
- [ ] Create reference search/indexing
- [ ] Performance optimization

## Configuration

```json
{
  "context_management": {
    "jit_enabled": true,
    "reference_threshold": 5000, // Create reference if data > 5KB
    "auto_extract_references": true,
    "reference_storage": {
      "type": "sqlite", // or "file", "memory"
      "path": "~/.jazz/references.db"
    },
    "loading_strategy": {
      "preview_first": true, // Load preview before full content
      "max_load_size": 50000, // Don't load if > 50KB
      "cache_loaded": true // Cache loaded references
    }
  }
}
```

## Summary

**Just-in-time context** transforms how Jazz agents manage information:

1. **Store references, not data**: Lightweight identifiers instead of full content
2. **Load on demand**: Use tools to fetch data when actually needed
3. **Adaptive reasoning**: Refine queries based on intermediate results
4. **Token efficiency**: Only pay for data actually used
5. **Unlimited scale**: Can reference datasets larger than context windows

This approach makes Jazz agents more efficient, cost-effective, and capable of handling real-world scale while maintaining the flexibility to reason adaptively.

**Key Insight**: Just like humans use file systems and search engines instead of memorizing everything, AI agents should use tools and references instead of loading everything into context upfront.

# Agent Memory Architectures

## Overview

Agent memory is what enables Jazz agents to learn, remember context, and improve over time. Without
memory, agents are stateless - every interaction starts from scratch. With memory, agents become
truly intelligent assistants that understand your preferences, remember past conversations, and
build knowledge over time.

## The Memory Challenge

**What should agents remember?**

- 📝 Conversation history
- 🎯 User preferences and patterns
- 📊 Task outcomes (what worked, what didn't)
- 🧠 Learned knowledge and facts
- 🔗 Relationships between concepts
- ⏱️ Temporal context (when things happened)

**Trade-offs:**

- **Volume vs. Relevance**: Can't include everything in context
- **Speed vs. Comprehensiveness**: Fast retrieval vs. thorough search
- **Structure vs. Flexibility**: Rigid schema vs. freeform data
- **Cost**: Storage and retrieval expenses

## Memory Architecture Options

### Option 1: Structured File Storage (Simple JSON/YAML)

Store memory as structured files in the filesystem.

```typescript
// src/services/memory/file-memory.ts

export interface FileMemoryStructure {
  readonly conversations: Record<string, Conversation>;
  readonly preferences: UserPreferences;
  readonly facts: readonly Fact[];
  readonly taskHistory: readonly TaskExecution[];
  readonly metadata: MemoryMetadata;
}

export interface Conversation {
  readonly id: string;
  readonly agentId: string;
  readonly userId?: string;
  readonly messages: readonly ChatMessage[];
  readonly startedAt: Date;
  readonly lastActivityAt: Date;
  readonly summary?: string;
  readonly tags?: readonly string[];
}

export interface UserPreferences {
  readonly communication: {
    readonly style?: "concise" | "detailed" | "balanced";
    readonly tone?: "formal" | "casual" | "friendly";
  };
  readonly workflows: Record<string, WorkflowPreference>;
  readonly toolPreferences: Record<string, boolean>; // enabled/disabled tools
  readonly customSettings: Record<string, unknown>;
}

export interface Fact {
  readonly id: string;
  readonly content: string;
  readonly source: string; // conversation ID or "user_input"
  readonly confidence: number; // 0-1
  readonly learnedAt: Date;
  readonly lastVerified?: Date;
  readonly tags?: readonly string[];
}

export interface TaskExecution {
  readonly id: string;
  readonly task: string;
  readonly agent: string;
  readonly success: boolean;
  readonly approach: string;
  readonly result?: string;
  readonly error?: string;
  readonly duration: number;
  readonly timestamp: Date;
}

export interface MemoryMetadata {
  readonly version: string;
  readonly createdAt: Date;
  readonly lastUpdatedAt: Date;
  readonly totalConversations: number;
  readonly totalFacts: number;
}
```

**Storage structure:**

```
~/.jazz/memory/
  ├── conversations/
  │   ├── conv-123.json
  │   ├── conv-456.json
  │   └── index.json
  ├── preferences.json
  ├── facts/
  │   └── facts.json
  ├── task-history/
  │   └── 2024-01/
  │       ├── tasks-01.json
  │       └── tasks-02.json
  └── metadata.json
```

**Pros:**

- ✅ Simple to implement
- ✅ Human-readable and editable
- ✅ Easy backup (just copy folder)
- ✅ No external dependencies
- ✅ Version control friendly (git)

**Cons:**

- ❌ Slow for large datasets
- ❌ No complex queries
- ❌ Manual indexing needed
- ❌ Poor concurrent access
- ❌ No semantic search

**Best for:**

- MVP and early development
- Small to medium memory size (<10k items)
- Single-user, single-instance

### Option 2: SQLite Database (Structured + Queryable)

Embedded SQL database for structured, queryable memory.

```typescript
// src/services/memory/sqlite-memory.ts

export interface SQLiteMemorySchema {
  conversations: {
    id: string;
    agent_id: string;
    user_id?: string;
    started_at: number;
    last_activity_at: number;
    summary?: string;
    metadata: string; // JSON
  };

  messages: {
    id: string;
    conversation_id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp: number;
    metadata: string; // JSON
  };

  facts: {
    id: string;
    content: string;
    source: string;
    confidence: number;
    learned_at: number;
    last_verified?: number;
    tags: string; // JSON array
  };

  preferences: {
    key: string;
    value: string; // JSON
    updated_at: number;
  };

  task_history: {
    id: string;
    task: string;
    agent_id: string;
    success: boolean;
    approach: string;
    result?: string;
    error?: string;
    duration: number;
    timestamp: number;
    metadata: string; // JSON
  };

  embeddings: {
    id: string;
    content_type: "message" | "fact" | "task";
    content_id: string;
    embedding: string; // Serialized float array or binary
    model: string;
    created_at: number;
  };
}

export class SQLiteMemoryService {
  constructor(private readonly db: Database) {}

  // Query recent conversations
  getRecentConversations(limit: number): Effect.Effect<Conversation[], Error> {
    return Effect.try(() =>
      this.db
        .prepare(
          `
          SELECT * FROM conversations 
          ORDER BY last_activity_at DESC 
          LIMIT ?
        `,
        )
        .all(limit),
    );
  }

  // Search facts by tag
  searchFactsByTag(tag: string): Effect.Effect<Fact[], Error> {
    return Effect.try(() =>
      this.db
        .prepare(
          `
          SELECT * FROM facts 
          WHERE json_extract(tags, '$') LIKE ?
        `,
        )
        .all(`%${tag}%`),
    );
  }

  // Get task success rate for an agent
  getAgentSuccessRate(agentId: string): Effect.Effect<number, Error> {
    return Effect.try(() => {
      const result = this.db
        .prepare(
          `
          SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful
          FROM task_history
          WHERE agent_id = ?
        `,
        )
        .get(agentId);

      return result.successful / result.total;
    });
  }

  // Store conversation with full-text search
  createFTSIndex(): Effect.Effect<void, Error> {
    return Effect.try(() => {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts 
        USING fts5(
          conversation_id,
          content,
          content=messages,
          content_rowid=rowid
        );
        
        CREATE TRIGGER IF NOT EXISTS messages_fts_insert 
        AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, conversation_id, content)
          VALUES (new.rowid, new.conversation_id, new.content);
        END;
      `);
    });
  }

  // Full-text search across messages
  searchMessages(query: string): Effect.Effect<Message[], Error> {
    return Effect.try(() =>
      this.db
        .prepare(
          `
          SELECT m.* 
          FROM messages m
          JOIN messages_fts fts ON m.rowid = fts.rowid
          WHERE messages_fts MATCH ?
          ORDER BY rank
        `,
        )
        .all(query),
    );
  }
}
```

**Database file:**

```
~/.jazz/memory/jazz.db
```

**Schema migrations:**

```typescript
export const migrations = [
  {
    version: 1,
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          user_id TEXT,
          started_at INTEGER NOT NULL,
          last_activity_at INTEGER NOT NULL,
          summary TEXT,
          metadata TEXT
        );
        
        CREATE INDEX idx_conversations_agent ON conversations(agent_id);
        CREATE INDEX idx_conversations_user ON conversations(user_id);
      `);
    },
  },
  // ... more migrations
];
```

**Pros:**

- ✅ Fast queries with indexes
- ✅ ACID transactions
- ✅ Full-text search (FTS5)
- ✅ No external server needed
- ✅ Good for structured queries
- ✅ Handles concurrent reads well

**Cons:**

- ❌ No native vector/semantic search
- ❌ Schema migrations needed
- ❌ Binary format (not human-readable)
- ❌ Concurrent writes can be tricky
- ❌ Limited to single machine

**Best for:**

- Production single-user deployment
- Structured queries and analytics
- Medium to large datasets (10k-1M items)
- Need transaction guarantees

### Option 3: Vector Database (Semantic Search)

Store embeddings for semantic/similarity search.

```typescript
// src/services/memory/vector-memory.ts

export interface VectorMemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly embedding: number[]; // 1536-dim for OpenAI, 768 for sentence-transformers
  readonly metadata: {
    readonly type: "conversation" | "fact" | "task";
    readonly timestamp: Date;
    readonly agentId?: string;
    readonly tags?: readonly string[];
    readonly [key: string]: unknown;
  };
}

/**
 * Vector DB Options:
 * 1. Embedded: Chroma (Python), LanceDB (Rust)
 * 2. Self-hosted: Qdrant, Weaviate, Milvus
 * 3. Cloud: Pinecone, Weaviate Cloud
 */

// Example with LanceDB (embedded, TypeScript-friendly)
import * as lancedb from "vectordb";

export class VectorMemoryService {
  private connection?: lancedb.Connection;
  private table?: lancedb.Table;

  async initialize(dbPath: string): Promise<void> {
    this.connection = await lancedb.connect(dbPath);

    try {
      this.table = await this.connection.openTable("memory");
    } catch {
      // Create table if doesn't exist
      this.table = await this.connection.createTable("memory", [
        {
          id: "init",
          content: "Initialization entry",
          vector: new Array(1536).fill(0),
          metadata: { type: "system" },
        },
      ]);
    }
  }

  // Store memory with embedding
  storeMemory(
    content: string,
    metadata: Record<string, unknown>,
  ): Effect.Effect<void, Error, LLMService> {
    return Effect.gen(
      function* (this: VectorMemoryService) {
        const llmService = yield* LLMServiceTag;

        // Generate embedding
        const embedding = yield* llmService.createEmbedding({
          input: content,
          model: "text-embedding-3-small",
        });

        // Store in vector DB
        yield* Effect.promise(() =>
          this.table!.add([
            {
              id: uuid(),
              content,
              vector: embedding,
              metadata,
            },
          ]),
        );
      }.bind(this),
    );
  }

  // Semantic search
  searchSimilar(query: string, limit = 10): Effect.Effect<VectorMemoryEntry[], Error, LLMService> {
    return Effect.gen(
      function* (this: VectorMemoryService) {
        const llmService = yield* LLMServiceTag;

        // Generate query embedding
        const queryEmbedding = yield* llmService.createEmbedding({
          input: query,
          model: "text-embedding-3-small",
        });

        // Vector similarity search
        const results = yield* Effect.promise(() =>
          this.table!.search(queryEmbedding).limit(limit).execute(),
        );

        return results as VectorMemoryEntry[];
      }.bind(this),
    );
  }

  // Hybrid search: semantic + filters
  searchWithFilters(
    query: string,
    filters: Record<string, unknown>,
    limit = 10,
  ): Effect.Effect<VectorMemoryEntry[], Error, LLMService> {
    return Effect.gen(
      function* (this: VectorMemoryService) {
        const llmService = yield* LLMServiceTag;
        const queryEmbedding = yield* llmService.createEmbedding({
          input: query,
          model: "text-embedding-3-small",
        });

        // Build filter expression
        const filterExpr = Object.entries(filters)
          .map(([key, value]) => `metadata.${key} = '${value}'`)
          .join(" AND ");

        const results = yield* Effect.promise(() =>
          this.table!.search(queryEmbedding).where(filterExpr).limit(limit).execute(),
        );

        return results as VectorMemoryEntry[];
      }.bind(this),
    );
  }
}
```

**Pros:**

- ✅ Semantic/similarity search
- ✅ Find related memories by meaning
- ✅ Great for RAG (Retrieval-Augmented Generation)
- ✅ Handles unstructured data well
- ✅ Natural for LLM workflows

**Cons:**

- ❌ Requires embeddings (cost + latency)
- ❌ Complex setup for some solutions
- ❌ Not great for exact matches
- ❌ Storage overhead (vectors are large)
- ❌ Can be expensive at scale

**Best for:**

- Semantic memory retrieval
- "Remember when I..." queries
- Large unstructured knowledge bases
- Multi-agent systems needing shared memory

### Option 4: Graph Database (Relationship-Focused)

Model memory as a graph of connected concepts.

```typescript
// src/services/memory/graph-memory.ts

/**
 * Graph structure:
 *
 * (User) --OWNS--> (Preference)
 * (Agent) --EXECUTED--> (Task)
 * (Task) --USED--> (Tool)
 * (Conversation) --CONTAINS--> (Message)
 * (Message) --MENTIONS--> (Entity)
 * (Entity) --RELATED_TO--> (Entity)
 * (Fact) --DERIVED_FROM--> (Conversation)
 */

export interface Node {
  readonly id: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface Edge {
  readonly id: string;
  readonly from: string; // Node ID
  readonly to: string; // Node ID
  readonly type: string; // Relationship type
  readonly properties?: Record<string, unknown>;
  readonly createdAt: Date;
}

// Example with simple in-memory graph (or use Neo4j, TypeDB, etc.)
export class GraphMemoryService {
  constructor(
    private readonly nodes: Ref.Ref<Map<string, Node>>,
    private readonly edges: Ref.Ref<Map<string, Edge>>,
    private readonly index: Ref.Ref<Map<string, Set<string>>>, // type -> node IDs
  ) {}

  static create(): Effect.Effect<GraphMemoryService, never> {
    return Effect.gen(function* () {
      const nodes = yield* Ref.make(new Map<string, Node>());
      const edges = yield* Ref.make(new Map<string, Edge>());
      const index = yield* Ref.make(new Map<string, Set<string>>());
      return new GraphMemoryService(nodes, edges, index);
    });
  }

  // Add a node
  addNode(node: Omit<Node, "createdAt">): Effect.Effect<Node, Error> {
    return Effect.gen(
      function* (this: GraphMemoryService) {
        const fullNode: Node = {
          ...node,
          createdAt: new Date(),
        };

        yield* Ref.update(this.nodes, (nodes) => new Map(nodes).set(node.id, fullNode));

        // Update index
        yield* Ref.update(this.index, (index) => {
          const typeIndex = index.get(node.type) || new Set();
          typeIndex.add(node.id);
          return new Map(index).set(node.type, typeIndex);
        });

        return fullNode;
      }.bind(this),
    );
  }

  // Add an edge (relationship)
  addEdge(edge: Omit<Edge, "id" | "createdAt">): Effect.Effect<Edge, Error> {
    return Effect.gen(
      function* (this: GraphMemoryService) {
        const fullEdge: Edge = {
          ...edge,
          id: uuid(),
          createdAt: new Date(),
        };

        yield* Ref.update(this.edges, (edges) => new Map(edges).set(fullEdge.id, fullEdge));

        return fullEdge;
      }.bind(this),
    );
  }

  // Find all nodes of a type
  getNodesByType(type: string): Effect.Effect<Node[], Error> {
    return Effect.gen(
      function* (this: GraphMemoryService) {
        const index = yield* Ref.get(this.index);
        const nodes = yield* Ref.get(this.nodes);

        const nodeIds = index.get(type) || new Set();
        return Array.from(nodeIds)
          .map((id) => nodes.get(id))
          .filter((n): n is Node => n !== undefined);
      }.bind(this),
    );
  }

  // Find connected nodes (traverse graph)
  getConnectedNodes(
    nodeId: string,
    relationshipType?: string,
    depth = 1,
  ): Effect.Effect<Node[], Error> {
    return Effect.gen(
      function* (this: GraphMemoryService) {
        const edges = yield* Ref.get(this.edges);
        const nodes = yield* Ref.get(this.nodes);

        const visited = new Set<string>();
        const result: Node[] = [];

        const traverse = (currentId: string, currentDepth: number) => {
          if (currentDepth > depth || visited.has(currentId)) return;
          visited.add(currentId);

          // Find outgoing edges
          const outgoing = Array.from(edges.values()).filter(
            (edge) =>
              edge.from === currentId && (!relationshipType || edge.type === relationshipType),
          );

          for (const edge of outgoing) {
            const node = nodes.get(edge.to);
            if (node) {
              result.push(node);
              traverse(edge.to, currentDepth + 1);
            }
          }
        };

        traverse(nodeId, 0);
        return result;
      }.bind(this),
    );
  }

  // Path finding: find connection between two nodes
  findPath(fromId: string, toId: string): Effect.Effect<readonly Node[], Error> {
    return Effect.gen(
      function* (this: GraphMemoryService) {
        const edges = yield* Ref.get(this.edges);
        const nodes = yield* Ref.get(this.nodes);

        // BFS to find shortest path
        const queue: Array<{ nodeId: string; path: string[] }> = [
          { nodeId: fromId, path: [fromId] },
        ];
        const visited = new Set<string>();

        while (queue.length > 0) {
          const { nodeId, path } = queue.shift()!;

          if (nodeId === toId) {
            return path.map((id) => nodes.get(id)).filter((n): n is Node => n !== undefined);
          }

          if (visited.has(nodeId)) continue;
          visited.add(nodeId);

          // Find neighbors
          const outgoing = Array.from(edges.values()).filter((edge) => edge.from === nodeId);

          for (const edge of outgoing) {
            queue.push({
              nodeId: edge.to,
              path: [...path, edge.to],
            });
          }
        }

        return [];
      }.bind(this),
    );
  }

  // Query: "What tasks did agent X complete successfully?"
  queryAgentTasks(agentId: string): Effect.Effect<Node[], Error> {
    return Effect.gen(
      function* (this: GraphMemoryService) {
        const edges = yield* Ref.get(this.edges);
        const nodes = yield* Ref.get(this.nodes);

        const tasks = Array.from(edges.values())
          .filter((edge) => edge.from === agentId && edge.type === "EXECUTED")
          .map((edge) => nodes.get(edge.to))
          .filter((node): node is Node => node !== undefined && node.properties.success === true);

        return tasks;
      }.bind(this),
    );
  }
}

// Persistence: Store graph to JSON or use Neo4j
export function serializeGraph(service: GraphMemoryService): Effect.Effect<string, Error> {
  return Effect.gen(function* () {
    const nodes = yield* Ref.get((service as any).nodes);
    const edges = yield* Ref.get((service as any).edges);

    return JSON.stringify({
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values()),
    });
  });
}
```

**Neo4j example (professional graph DB):**

```typescript
import neo4j from "neo4j-driver";

export class Neo4jMemoryService {
  constructor(private readonly driver: neo4j.Driver) {}

  // Cypher query example
  getAgentKnowledge(agentId: string): Effect.Effect<any[], Error> {
    return Effect.promise(async () => {
      const session = this.driver.session();
      try {
        const result = await session.run(
          `
          MATCH (a:Agent {id: $agentId})-[:LEARNED]->(f:Fact)
          RETURN f
          ORDER BY f.confidence DESC
          LIMIT 10
        `,
          { agentId },
        );
        return result.records.map((record) => record.get("f"));
      } finally {
        await session.close();
      }
    });
  }

  // Find related concepts
  findRelatedConcepts(conceptId: string, depth = 2): Effect.Effect<any[], Error> {
    return Effect.promise(async () => {
      const session = this.driver.session();
      try {
        const result = await session.run(
          `
          MATCH path = (c:Concept {id: $conceptId})-[*1..${depth}]-(related:Concept)
          RETURN DISTINCT related, length(path) as distance
          ORDER BY distance
        `,
          { conceptId },
        );
        return result.records.map((record) => ({
          concept: record.get("related"),
          distance: record.get("distance"),
        }));
      } finally {
        await session.close();
      }
    });
  }
}
```

**Pros:**

- ✅ Natural for relationships
- ✅ Complex queries on connections
- ✅ Path finding and traversal
- ✅ Explainable reasoning
- ✅ Great for knowledge graphs

**Cons:**

- ❌ Complex to set up
- ❌ Steeper learning curve (Cypher, etc.)
- ❌ Overkill for simple use cases
- ❌ Requires external database (Neo4j)
- ❌ Can be slow for large graphs

**Best for:**

- Complex relationship queries
- Knowledge graph applications
- Multi-agent coordination
- Explainable AI reasoning
- Enterprise deployments

### Option 5: Hybrid Approach (Recommended)

Combine multiple storage systems for optimal performance.

```typescript
// src/services/memory/hybrid-memory.ts

export class HybridMemoryService {
  constructor(
    private readonly structured: SQLiteMemoryService, // For queries & analytics
    private readonly vector: VectorMemoryService, // For semantic search
    private readonly graph: GraphMemoryService, // For relationships
    private readonly cache: Ref.Ref<Map<string, any>>, // In-memory cache
  ) {}

  /**
   * Storage strategy:
   *
   * SQLite:
   * - Conversation metadata
   * - Task history
   * - User preferences
   * - Time-series data
   *
   * Vector DB:
   * - Message embeddings
   * - Fact embeddings
   * - Semantic search index
   *
   * Graph:
   * - Entity relationships
   * - Knowledge graph
   * - Agent coordination state
   *
   * Cache:
   * - Recent conversations
   * - Active agent state
   * - Frequently accessed data
   */

  // Store a conversation (writes to multiple stores)
  storeConversation(conversation: Conversation): Effect.Effect<void, Error, LLMService> {
    return Effect.gen(
      function* (this: HybridMemoryService) {
        // 1. Store structured data in SQLite
        yield* this.structured.saveConversation(conversation);

        // 2. Store message embeddings in vector DB
        for (const message of conversation.messages) {
          if (message.role === "user" || message.role === "assistant") {
            yield* this.vector.storeMemory(message.content, {
              type: "message",
              conversationId: conversation.id,
              role: message.role,
              timestamp: conversation.startedAt,
            });
          }
        }

        // 3. Extract entities and relationships for graph
        yield* this.extractAndStoreRelationships(conversation);

        // 4. Cache in memory
        yield* Ref.update(this.cache, (cache) =>
          new Map(cache).set(`conv-${conversation.id}`, conversation),
        );
      }.bind(this),
    );
  }

  // Intelligent retrieval: combines semantic + structured + graph
  retrieveRelevantMemory(
    query: string,
    context: {
      agentId: string;
      userId?: string;
      conversationId?: string;
    },
  ): Effect.Effect<RelevantMemory, Error, LLMService> {
    return Effect.gen(
      function* (this: HybridMemoryService) {
        // 1. Semantic search for similar past interactions
        const similarMemories = yield* this.vector.searchWithFilters(
          query,
          {
            agentId: context.agentId,
          },
          5,
        );

        // 2. Get recent conversations from SQLite
        const recentConversations = yield* this.structured.getRecentConversations(3);

        // 3. Get user preferences
        const preferences = yield* this.structured.getUserPreferences(context.userId || "default");

        // 4. Find related concepts in graph
        const relatedConcepts = yield* this.graph.getConnectedNodes(
          context.agentId,
          "KNOWS_ABOUT",
          2,
        );

        // 5. Combine and rank
        return {
          similarMemories,
          recentConversations,
          preferences,
          relatedConcepts,
        };
      }.bind(this),
    );
  }

  // Extract entities and build knowledge graph
  private extractAndStoreRelationships(
    conversation: Conversation,
  ): Effect.Effect<void, Error, LLMService> {
    return Effect.gen(
      function* (this: HybridMemoryService) {
        const llmService = yield* LLMServiceTag;

        // Use LLM to extract entities and relationships
        const prompt = `Extract entities and relationships from this conversation:

${conversation.messages.map((m) => `${m.role}: ${m.content}`).join("\n")}

Return JSON: { "entities": [...], "relationships": [...] }`;

        const response = yield* llmService.chat({
          messages: [{ role: "user", content: prompt }],
          provider: "openai",
          model: "gpt-4o-mini",
        });

        const extracted = JSON.parse(response.content);

        // Store in graph
        for (const entity of extracted.entities) {
          yield* this.graph.addNode({
            id: `entity-${uuid()}`,
            type: "Entity",
            properties: entity,
          });
        }

        for (const rel of extracted.relationships) {
          yield* this.graph.addEdge({
            from: rel.from,
            to: rel.to,
            type: rel.type,
            properties: rel.properties,
          });
        }
      }.bind(this),
    );
  }
}

export interface RelevantMemory {
  readonly similarMemories: readonly VectorMemoryEntry[];
  readonly recentConversations: readonly Conversation[];
  readonly preferences: UserPreferences;
  readonly relatedConcepts: readonly Node[];
}
```

## Comparison Matrix

| Feature              | File Storage | SQLite   | Vector DB  | Graph DB   | Hybrid     |
| -------------------- | ------------ | -------- | ---------- | ---------- | ---------- |
| **Simplicity**       | ⭐⭐⭐⭐⭐   | ⭐⭐⭐⭐ | ⭐⭐       | ⭐         | ⭐⭐       |
| **Query Speed**      | ⭐           | ⭐⭐⭐⭐ | ⭐⭐⭐     | ⭐⭐⭐     | ⭐⭐⭐⭐   |
| **Semantic Search**  | ❌           | ❌       | ⭐⭐⭐⭐⭐ | ⭐⭐       | ⭐⭐⭐⭐⭐ |
| **Relationships**    | ❌           | ⭐⭐     | ❌         | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| **Scalability**      | ⭐⭐         | ⭐⭐⭐   | ⭐⭐⭐⭐   | ⭐⭐⭐     | ⭐⭐⭐⭐   |
| **Setup Complexity** | ⭐⭐⭐⭐⭐   | ⭐⭐⭐⭐ | ⭐⭐       | ⭐         | ⭐⭐       |
| **External Deps**    | None         | None     | Optional   | Yes        | Optional   |
| **Human Readable**   | ✅           | ❌       | ❌         | ❌         | ⭐⭐       |
| **Cost**             | Free         | Free     | $$         | $$$        | $$         |

## Recommended Architecture for Jazz

### Phase 1: MVP (File + SQLite)

```
Start simple:
- File storage for configuration
- SQLite for conversations and history
- In-memory cache for active sessions
```

### Phase 2: Semantic Memory (Add Vector DB)

```
Add intelligence:
- LanceDB/Chroma for embeddings
- Semantic search for "remember when..."
- RAG for knowledge retrieval
```

### Phase 3: Knowledge Graph (Add Graph DB)

```
Advanced reasoning:
- In-memory graph for relationships
- Persist to JSON or Neo4j
- Complex multi-agent coordination
```

### Final Architecture

```
┌─────────────────────────────────────────────┐
│           Agent Memory Layer                │
├─────────────────────────────────────────────┤
│  Hybrid Memory Service (Unified Interface)  │
├──────────┬──────────┬──────────┬───────────┤
│ SQLite   │ Vector   │ Graph    │ Cache     │
│ (struct) │ (semantic)│(relations)│(active)  │
├──────────┴──────────┴──────────┴───────────┤
│         Storage Abstraction Layer           │
└─────────────────────────────────────────────┘
         ↓               ↓              ↓
    ~/.jazz/         Vector Store    In-Memory
    memory.db        (LanceDB)       (Ref/Map)
```

## Implementation Roadmap

### Phase 1: Core Memory (Week 1-2)

- [ ] File-based configuration storage
- [ ] SQLite setup with migrations
- [ ] Basic conversation storage
- [ ] User preferences

### Phase 2: Query & Retrieval (Week 3)

- [ ] Full-text search (SQLite FTS5)
- [ ] Task history analytics
- [ ] Memory compression/summarization
- [ ] Cache layer

### Phase 3: Semantic Memory (Week 4-5)

- [ ] Embedding generation
- [ ] Vector storage (LanceDB)
- [ ] Semantic search
- [ ] RAG integration

### Phase 4: Knowledge Graph (Week 6+)

- [ ] Entity extraction
- [ ] Relationship mapping
- [ ] Graph queries
- [ ] Visualization tools

## Memory Management Strategies

### Conversation Summarization

```typescript
// Automatically summarize old conversations
async function summarizeAndCompress(
  conversationId: string,
): Effect.Effect<void, Error, LLMService> {
  return Effect.gen(function* () {
    const conversation = yield* getConversation(conversationId);

    if (conversation.messages.length < 10) return; // Too short

    const llm = yield* LLMServiceTag;
    const summary = yield* llm.chat({
      messages: [
        {
          role: "user",
          content: `Summarize this conversation:\n\n${formatConversation(conversation)}`,
        },
      ],
      model: "gpt-4o-mini",
    });

    // Store summary, archive full messages
    yield* updateConversation(conversationId, {
      summary: summary.content,
      archived: true,
    });
  });
}
```

### Forgetting Strategy

```typescript
// Forget old, low-importance memories
export interface ForgettingPolicy {
  readonly maxAge: number; // days
  readonly minConfidence: number;
  readonly keepIfReferenced: boolean;
}

function applyForgettingPolicy(policy: ForgettingPolicy): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - policy.maxAge);

    // Delete old, low-confidence facts
    const deleted = yield* deleteFacts({
      learnedBefore: cutoffDate,
      confidenceBelow: policy.minConfidence,
      notReferenced: policy.keepIfReferenced,
    });

    return deleted;
  });
}
```

## Memory Privacy & Security

```typescript
export interface MemoryPrivacyConfig {
  readonly encryptAtRest: boolean;
  readonly encryptionKey?: string;
  readonly anonymizeUserId: boolean;
  readonly retentionDays?: number;
  readonly excludePatterns?: readonly RegExp[]; // Don't store matching content
}

// Encrypt sensitive data
function encryptMemory(content: string, key: string): string {
  // Use crypto to encrypt
  return encrypt(content, key);
}

// Anonymize user identifiers
function anonymizeUserId(userId: string): string {
  return hashUserId(userId);
}
```

## Summary & Recommendation

**For Jazz, start with: SQLite + Vector DB (Hybrid)**

1. **SQLite** for:
   - Conversations
   - Task history
   - Preferences
   - Analytics

2. **LanceDB/Chroma** for:
   - Semantic search
   - Similar memory retrieval
   - RAG knowledge base

3. **In-Memory** for:
   - Active sessions
   - Hot cache
   - Real-time state

4. **Future: Graph** when needed for:
   - Complex relationships
   - Multi-agent coordination
   - Knowledge reasoning

This gives you the best balance of simplicity, power, and scalability! 🚀

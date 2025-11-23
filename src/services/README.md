# Services Layer (`src/services`)

## Purpose

The **Services** layer (also called **Infrastructure** or **Adapters**) contains **implementations** of the interfaces defined in `core`. This layer handles all external dependencies: APIs, databases, file systems, logging, and third-party SDKs.

## Architecture Principles

1. **Implements Core Interfaces**: Every service implements a contract from `core/interfaces`
2. **Depends on Core**: Services import from `core`, never the other way around
3. **Handles I/O**: All external communication happens here

## Key Concepts

### Adapters Pattern

Services are **Adapters** that translate between:

- **Core's interfaces** (what the application needs)
- **External libraries** (how those needs are fulfilled)

Example:

```typescript
// Core defines the contract
interface LLMService {
  createChatCompletion(...): Effect<Response, Error>;
}

// Service implements using AI SDK
class AISDKService implements LLMService {
  createChatCompletion(...) {
    // Uses @ai-sdk/openai, @ai-sdk/anthropic, etc.
    return Effect.tryPromise(() => generateText(...));
  }
}
```

### Configuration Service

**Purpose**: Manages application configuration from files and environment

**Implementation**: `config.ts`

- Loads from `~/.jazz/config.json` or custom path
- Merges with defaults
- Provides Effect-based access

**Interface**: `core/interfaces/config.ts`

### Logger Service

**Purpose**: Structured logging with file and console output

**Implementation**: `logger.ts`

- Writes to `logs/jazz.log`
- Provides debug, info, warn, error levels
- Non-blocking writes

**Interface**: `core/interfaces/logger.ts`

### LLM Service

**Purpose**: Abstracts multiple LLM providers (OpenAI, Anthropic, Google, etc.)

**Implementation**: `llm/ai-sdk-service.ts`

- Uses Vercel AI SDK for multi-provider support
- Handles streaming and non-streaming completions
- Manages reasoning models (o1, Claude extended thinking, etc.)

**Providers Supported**:

- OpenAI (GPT-4, o1)
- Anthropic (Claude)
- Google (Gemini)
- Mistral
- xAI (Grok)
- DeepSeek
- Ollama (local)

**Interface**: `core/interfaces/llm.ts`

## Guidelines for Maintainers

### Adding a New Service

1. **Define Interface** in `core/interfaces/`

   ```typescript
   // core/interfaces/database.ts
   export interface DatabaseService {
     save(data: AgentData): Effect.Effect<void, DatabaseError>;
   }
   ```

2. **Implement in Services**

   ```typescript
   // services/postgres.ts
   import { DatabaseService } from "../core/interfaces/database";

   class PostgresService implements DatabaseService {
     save(data) {
       /* Postgres-specific logic */
     }
   }
   ```

3. **Create Layer** for dependency injection
   ```typescript
   export const PostgresLayer = Layer.effect(
     DatabaseServiceTag,
     Effect.succeed(new PostgresService()),
   );
   ```

### Adding a New LLM Provider

1. Add provider config to `llm/models.ts`
2. Add API key handling in `ai-sdk-service.ts`
3. Configure provider-specific options (reasoning, thinking, etc.)

### What Belongs in Services?

✅ **YES** - Infrastructure and external dependencies

- API clients (OpenAI SDK, Anthropic SDK)
- Database connections
- File system operations
- External API integrations (Gmail, Linear, etc.)
- Configuration loading
- Logging implementations

❌ **NO** - Business logic

- Agent execution flow → `core/agent/`
- Domain rules → `core/`
- UI rendering → `cli/`

### Testing

Services should be tested with:

- **Integration tests**: Test real external dependencies when possible
- **Mocking**: Use test doubles for expensive operations
- **Effect testing**: Leverage Effect's testing utilities

Example:

```typescript
// Test LLM service with a mock provider
const mockLLM = Layer.succeed(LLMServiceTag, {
  createChatCompletion: () => Effect.succeed(mockResponse),
});
```

## Common Patterns

### Effect Layers

Services are provided via Effect's Layer system:

```typescript
// Create a layer
const ConfigLayer = createConfigLayer();
const LoggerLayer = createLoggerLayer();
const LLMLayer = createAISDKServiceLayer();

// Compose layers
const AppLayer = Layer.mergeAll(ConfigLayer, LoggerLayer, LLMLayer);

// Use in application
Effect.runPromise(myProgram.pipe(Effect.provide(AppLayer)));
```

### Service Tags

Services are accessed via Context tags:

```typescript
const llm = yield * LLMServiceTag;
const logger = yield * LoggerServiceTag;
const config = yield * AgentConfigService;
```

## External Dependencies

### AI SDK Integration

We use **Vercel AI SDK** (`ai` package) for LLM providers:

- Unified API across providers
- Built-in streaming support
- Tool calling abstraction
- Reasoning model support

### File System

Uses Node.js `fs` with Effect-TS `@effect/platform` for:

- Configuration files
- Log files
- Agent storage

## Future Enhancements

Easy to add:

- **New LLM Providers**: Add to `llm/models.ts`
- **Database Storage**: Implement `DatabaseService` interface
- **External APIs**: New service modules (e.g., `linear.ts`, `notion.ts`)
- **Caching**: Add `CacheService` implementation

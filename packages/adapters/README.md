# `@jazz/adapters`

## Overview

`@jazz/adapters` contains **implementations** of the interfaces defined in `@jazz/core`. This
package handles all external dependencies: APIs, databases, file systems, logging, and
third-party SDKs.

**Key Responsibilities**:

- Implement service contracts defined in `@jazz/core/interfaces/`
- Handle all I/O operations (APIs, file system, databases)
- Integrate with third-party SDKs and external services
- Provide Effect Layers for dependency injection

## Architecture

### Role in the System

`@jazz/adapters` translates between:

```
┌─────────────────────────────────────────┐
│  @jazz/core                             │
│  - Defines interfaces (ports)           │
│  - Business logic                       │
└──────┬──────────────────────────────────┘
       │ uses interfaces
       │
┌──────▼──────────────────────────────────┐
│  @jazz/adapters                         │
│  - Implements interfaces                │
│  - External APIs                        │
│  - Infrastructure                       │
└─────────────────────────────────────────┘
```

### Design Principles

1. **Implements Core Interfaces**: Every adapter implements a contract from `@jazz/core/interfaces/`
2. **Depends on Core**: Adapters import from `@jazz/core`, never the other way around
3. **Handles I/O**: All external communication happens here

## Key Components

`@jazz/adapters` contains implementations organized by functionality:

- **`llm/`** - LLM service implementations using Vercel AI SDK
- **`storage/`** - Storage service implementations (file-based and in-memory)
- **`config.ts`** - Configuration service
- **`logger.ts`** - Logging service
- **`gmail.ts`** - Gmail API integration
- **`fs.ts`** - File system service

### Services Overview

**LLM Service** (`llm/ai-sdk-service.ts`)

- Implements `@jazz/core/interfaces/llm.ts`
- Uses Vercel AI SDK for multi-provider support
- Supports: OpenAI, Anthropic, Google, Mistral, xAI, DeepSeek, Ollama
- Handles streaming and reasoning models

**Storage Service** (`storage/file.ts`)

- Implements `@jazz/core/interfaces/storage.ts`
- File-based agent storage
- JSON serialization

**Configuration Service** (`config.ts`)

- Implements `@jazz/core/interfaces/agent-config.ts`
- Loads from `~/.jazz/config.json` or custom path
- Merges with defaults

**Logger Service** (`logger.ts`)

- Implements `@jazz/core/interfaces/logger.ts`
- Structured logging to `logs/jazz.log`
- Debug, info, warn, error levels

**Gmail Service** (`gmail.ts`)

- Implements `@jazz/core/interfaces/gmail.ts`
- Gmail API integration for email tools

### Adapters Pattern

Services are **Adapters** that translate between:

- **Core's interfaces** (what the application needs)
- **External libraries** (how those needs are fulfilled)

Example:

```typescript
// Core defines the contract (@jazz/core/interfaces/llm.ts)
interface LLMService {
  createChatCompletion(...): Effect<Response, Error>;
}

// Service implements using AI SDK (@jazz/adapters/llm/ai-sdk-service.ts)
class AISDKService implements LLMService {
  createChatCompletion(...) {
    // Uses @ai-sdk/openai, @ai-sdk/anthropic, etc.
    return Effect.tryPromise(() => generateText(...));
  }
}
```

## Development Guide

### Adding a New Service

1. **Define Interface** in `@jazz/core/interfaces/`

   ```typescript
   // @jazz/core/interfaces/my-service.ts
   export interface MyService {
     doSomething(): Effect.Effect<Result, Error>;
   }
   ```

2. **Implement in Services**

   ```typescript
   // @jazz/adapters/my-service.ts
   import type { MyService } from "@jazz/core/interfaces/my-service";

   class MyServiceImpl implements MyService {
     doSomething() {
       /* Implementation using external libraries */
     }
   }
   ```

3. **Create Layer** for dependency injection

   ```typescript
   export const MyServiceLayer = Layer.effect(MyServiceTag, Effect.succeed(new MyServiceImpl()));
   ```

4. **Wire in `@jazz/runtime/app-layer.ts`**

   Add the layer to `createAppLayer()` function.

### Adding a New LLM Provider

1. Add provider config to `llm/models.ts`
2. Add API key handling in `llm/ai-sdk-service.ts`
3. Configure provider-specific options (reasoning, thinking, etc.)

### What Belongs in Adapters?

✅ **YES** - Infrastructure and external dependencies

- API clients (OpenAI SDK, Anthropic SDK) → `llm/`
- Database connections → `storage/` or new service
- File system operations → `fs.ts`
- External API integrations (Gmail, etc.) → `gmail.ts`, etc.
- Configuration loading → `config.ts`
- Logging implementations → `logger.ts`

❌ **NO** - Business logic

- Agent execution flow → `@jazz/core/agent/`
- Domain rules → `@jazz/core/`
- UI rendering → `@jazz/cli/`

### Testing

Adapters should be tested with:

- **Integration tests**: Test real external dependencies when possible
- **Mocking**: Use test doubles for expensive operations
- **Effect testing**: Leverage Effect's testing utilities

```typescript
// Test with mock service
const mockService = Layer.succeed(ServiceTag, {
  doSomething: () => Effect.succeed(mockResult),
});
```

## Common Patterns

### Effect Layers

Services are provided via Effect's Layer system and composed in `@jazz/runtime/app-layer.ts`:

```typescript
// Create individual layers
const ConfigLayer = createConfigLayer();
const LoggerLayer = createLoggerLayer();
const LLMLayer = createAISDKServiceLayer();

// Compose into app layer
const AppLayer = Layer.mergeAll(ConfigLayer, LoggerLayer, LLMLayer);

// Use in application
Effect.runPromise(myProgram.pipe(Effect.provide(AppLayer)));
```

### Service Tags

Services are accessed via Effect Context tags:

```typescript
const llm = yield * LLMServiceTag;
const logger = yield * LoggerServiceTag;
const config = yield * AgentConfigServiceTag;
```

## External Dependencies

### AI SDK Integration

Uses **Vercel AI SDK** (`ai` package) for LLM providers:

- Unified API across providers
- Built-in streaming support
- Tool calling abstraction
- Reasoning model support

### File System

Uses Node.js `fs` with Effect-TS `@effect/platform` for:

- Configuration files
- Log files
- Agent storage

## Key Files

- **`llm/ai-sdk-service.ts`** - Main LLM service implementation
- **`storage/file.ts`** - File-based storage implementation
- **`config.ts`** - Configuration service
- **`logger.ts`** - Logging service
- **`gmail.ts`** - Gmail API integration

## Related Documentation

- **Core**: See `@jazz/core/README.md` for interface definitions
- **CLI**: See `@jazz/cli/README.md` for how adapters are used
- **Architecture**: See `docs/ARCHITECTURE.md` for system-wide architecture

**Critical Rule**: Adapters import from `@jazz/core/`, never the other way around. Adapters implement core interfaces.

# Core Layer (`src/core`)

## Purpose

The **Core** layer contains the **business logic, domain models, and application use cases**. It is the heart of the application and has **zero dependencies** on external libraries or infrastructure. This layer defines **what** the application does, not **how** it does it.

## Architecture Principles

Following **Clean Architecture** and **Hexagonal Architecture** (Ports & Adapters):

1. **Dependency Rule**: Core depends on nothing outside itself. All dependencies point inward.
2. **Interfaces (Ports)**: Core defines contracts that the infrastructure must implement.
3. **Domain Logic**: Business rules and use cases live here, independent of frameworks.

## Key Concepts

### Why Separate `interfaces/` and `types/`?

**`types/`** - **Data Structures** (Domain Models)

- Define the _shape_ of data
- Examples: `Agent`, `ChatMessage`, `ToolCall`
- Purpose: Represent domain concepts

**`interfaces/`** - **Contracts** (Ports)

- Define _behavior_ contracts
- Examples: `LLMService`, `LoggerService`, `ToolRegistry`
- Purpose: Abstract external dependencies

This separation enforces:

- **Single Responsibility**: Types describe data, interfaces describe capabilities
- **Dependency Inversion**: Infrastructure implements interfaces, core defines them
- **Testability**: Easy to mock interfaces without touching domain models

### Example: LLM Service

**Interface (Port)** - `core/interfaces/llm.ts`:

```typescript
export interface LLMService {
  readonly createChatCompletion: (
    provider: string,
    options: ChatCompletionOptions,
  ) => Effect.Effect<ChatCompletionResponse, LLMError>;
}
```

**Types (Domain)** - `core/types/llm.ts`:

```typescript
export interface ChatCompletionResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
}
```

**Implementation (Adapter)** - `services/llm/ai-sdk-service.ts`:

```typescript
class AISDKService implements LLMService {
  createChatCompletion(...) { /* uses AI SDK */ }
}
```

## Guidelines for Maintainers

### Adding New Features

#### 1. **New Domain Type**

- Add to appropriate file in `types/`
- Example: Adding a new skill type → `types/skill.ts`

#### 2. **New Service Contract**

- Add interface to `interfaces/`
- Implement in `services/`
- Example: Adding a database → `interfaces/database.ts`, `services/postgres.ts`

#### 3. **New Business Logic**

- Add to `agent/` subdirectories
- Keep it pure - no direct I/O or external calls
- Use dependency injection via interfaces

### What Belongs in Core?

✅ **YES** - Pure business logic and domain models

- Agent execution flow
- Context window management
- Domain types (Agent, Message, Tool)
- Service interfaces (contracts)

❌ **NO** - Infrastructure and UI concerns

- API clients (OpenAI SDK, Anthropic SDK)
- Database connections
- File system operations
- Terminal rendering (belongs in CLI layer)
- HTTP requests

### Testing Philosophy

Core should be **highly testable**:

- Mock interfaces, not implementations
- Test business logic without I/O
- Example: Test agent-runner by mocking `LLMService` interface

## Common Patterns

### Effect-TS

We use Effect for:

- Async operations
- Error handling (typed errors)
- Dependency injection (via Context)

### Dependency Injection

```typescript
function myLogic(): Effect.Effect<Result, Error, LLMService | LoggerService> {
  return Effect.gen(function* () {
    const llm = yield* LLMServiceTag;
    const logger = yield* LoggerServiceTag;
    // Use services...
  });
}
```

Services are provided at runtime via Effect's Layer system.

## Future Scalability

This architecture makes it easy to add:

- **Skills/Capabilities**: New domain types in `types/skills.ts`
- **Workflows**: New logic in `agent/workflows/`
- **Complex Context Management**: New modules in `agent/context/`
- **Custom Strategies**: Pluggable via interfaces

The key is maintaining the **Dependency Rule**: Core never imports from `services` or `cli`.

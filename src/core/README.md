# Core Layer (`src/core`)

## Overview

The **Core layer** is the **heart of the application** - it contains all business logic, domain models, and application use cases. This layer has **zero dependencies** on external libraries or infrastructure, making it framework-agnostic and highly testable.

**Key Responsibilities**:

- Business logic and domain rules
- Agent execution and orchestration
- Domain models and data structures
- Service contracts (interfaces) that infrastructure must implement

## Architecture

### Role in the System

The Core layer follows **Clean Architecture** and **Hexagonal Architecture** (Ports & Adapters):

```
┌─────────────────────────────────────────┐
│  Core Layer (src/core)                  │
│  - Business logic                       │
│  - Domain models                        │
│  - Service interfaces (ports)           │
│  - Agent execution                      │
└──────┬──────────────────────────────────┘
       │ defines contracts
       │
┌──────▼──────────────────────────────────┐
│  Services Layer (src/services)          │
│  - Implements interfaces                │
│  - External APIs                       │
│  - Infrastructure                      │
└────────────────────────────────────────┘
```

### Design Principles

1. **Dependency Rule**: Core depends on nothing outside itself. All dependencies point inward.
2. **Interfaces (Ports)**: Core defines contracts that infrastructure must implement.
3. **Domain Logic**: Business rules live here, independent of frameworks or external libraries.

## Key Components

The Core layer is organized into several key directories:

- **`agent/`** - Agent execution logic, context management, prompts, tools, and tracking
- **`interfaces/`** - Service contracts (ports) that define what infrastructure must implement
- **`types/`** - Domain models and data structures representing core concepts
- **`constants/`** - Application-wide constants
- **`utils/`** - Shared utility functions used across the core layer

### Interfaces vs Types

**`interfaces/`** - **Service Contracts** (Ports)

- Define _behavior_ contracts that infrastructure must implement
- Examples: `LLMService`, `StorageService`, `LoggerService`
- Located in `src/core/interfaces/`

**`types/`** - **Domain Models** (Data Structures)

- Define the _shape_ of domain data
- Examples: `Agent`, `ChatMessage`, `ToolCall`
- Located in `src/core/types/`

**Why Separate?**

- **Single Responsibility**: Types describe data, interfaces describe capabilities
- **Dependency Inversion**: Infrastructure implements interfaces, core defines them
- **Testability**: Easy to mock interfaces without touching domain models

### Agent Execution

The agent execution logic (`src/core/agent/`) handles:

- **Agent Runner** (`agent-runner.ts`) - Main execution engine that orchestrates agent interactions
- **Context Management** (`context-window-manager.ts`) - Manages conversation history and context windows
- **Tool Registry** (`tools/tool-registry.ts`) - Manages available tools and their execution
- **Prompt Templates** (`prompts/`) - Agent-specific prompt configurations

## Development Guide

### Adding New Features

#### 1. New Domain Type

Add to `src/core/types/`:

```typescript
// types/my-type.ts
export interface MyDomainType {
  id: string;
  // ... domain properties
}
```

#### 2. New Service Contract

Define interface in `src/core/interfaces/`, implement in `src/services/`:

```typescript
// interfaces/my-service.ts
export interface MyService {
  doSomething(): Effect.Effect<Result, Error>;
}

// services/my-service.ts (implementation)
class MyServiceImpl implements MyService {
  doSomething() {
    /* implementation */
  }
}
```

#### 3. New Business Logic

Add to `src/core/agent/`:

- Keep it pure - no direct I/O or external calls
- Use dependency injection via interfaces
- Example: New workflow → `agent/workflows/my-workflow.ts`

### What Belongs in Core?

✅ **YES** - Pure business logic and domain models

- Agent execution flow (`agent/agent-runner.ts`)
- Context window management (`agent/context-window-manager.ts`)
- Domain types (`types/`)
- Service interfaces (`interfaces/`)
- Business rules and use cases

❌ **NO** - Infrastructure and UI concerns

- API clients → `src/services/`
- Database connections → `src/services/`
- File system operations → `src/services/`
- Terminal rendering → `src/cli/`
- HTTP requests → `src/services/`

### Testing

Core should be **highly testable**:

- Mock interfaces, not implementations
- Test business logic without I/O
- Use Effect's testing utilities for dependency injection

```typescript
// Test agent-runner by mocking LLMService
const mockLLM = Layer.succeed(LLMServiceTag, {
  createChatCompletion: () => Effect.succeed(mockResponse),
});
```

## Common Patterns

### Effect-TS Usage

Core uses Effect-TS for:

- **Async Operations**: Effect.gen for async workflows
- **Error Handling**: Tagged errors with recovery strategies
- **Dependency Injection**: Effect Context for services

### Dependency Injection Pattern

```typescript
function myLogic(): Effect.Effect<Result, Error, LLMService | LoggerService> {
  return Effect.gen(function* () {
    const llm = yield* LLMServiceTag;
    const logger = yield* LoggerServiceTag;
    // Use services...
  });
}
```

Services are provided at runtime via Effect's Layer system (wired in `src/main.ts`).

## Key Files

- **`agent/agent-runner.ts`** - Main agent execution engine
- **`agent/context-window-manager.ts`** - Context window management
- **`agent/tools/tool-registry.ts`** - Tool registration and execution
- **`interfaces/llm.ts`** - LLM service contract
- **`interfaces/storage.ts`** - Storage service contract
- **`types/agent.ts`** - Agent domain model
- **`types/llm.ts`** - LLM-related domain types

## Related Documentation

- **CLI Layer**: See `src/cli/README.md` for how commands use core
- **Services**: See `src/services/README.md` for interface implementations
- **Architecture**: See `docs/ARCHITECTURE.md` for system-wide architecture

**Critical Rule**: Core never imports from `services/` or `cli/`. All dependencies point inward.

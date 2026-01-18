# Jazz — Architecture Overview

This document is a practical guide to the code organization and architectural conventions used in Jazz. It's focused on what contributors need to know to add features, implement adapters, and write tests.

---

## Core Principles

- **`core/`** contains the domain, contracts (interfaces and types), and business logic.
  - No imports from `services/` allowed in core/ except in tests.
  - Contracts are expressed as interfaces + Context tags (e.g., `AgentConfigServiceTag`).
- **`services/`** implements adapters (database, LLM providers, Gmail, file system, logger, etc.).
  - Services provide Layers that satisfy the tags declared in `core/interfaces`.
- **`cli/`** contains user-facing command implementations and presentation code.

---

## Directory Structure

```
src/
├── cli/                          # User-facing CLI
│   ├── commands/                 # Command implementations (chat, agent, config)
│   ├── presentation/             # Output formatting (markdown, CLI renderer)
│   └── ui/                       # Ink React components
│       ├── App.tsx               # Main app with store pattern
│       ├── ErrorBoundary.tsx     # Error boundary for graceful failures
│       ├── LineInput.tsx         # Readline-style input component
│       └── text-utils.ts         # Word boundary utilities
│
├── core/                         # Domain and contracts
│   ├── agent/                    # Agent execution engine
│   │   ├── agent-runner.ts       # Orchestrator (delegates to executors)
│   │   ├── types.ts              # Shared types (AgentRunnerOptions, etc.)
│   │   ├── context/              # Context management
│   │   │   └── summarizer.ts     # Auto-summarization for context window
│   │   ├── execution/            # LLM execution strategies
│   │   │   ├── streaming-executor.ts  # Real-time streaming
│   │   │   └── batch-executor.ts      # Non-streaming execution
│   │   ├── prompts/              # System prompts by agent type
│   │   └── tools/                # Tool implementations
│   │       ├── fs/               # Filesystem tools (read, write, grep, etc.)
│   │       ├── git/              # Git tools (status, commit, push, etc.)
│   │       └── register-tools.ts # Tool registration
│   ├── interfaces/               # Service contracts (Tag + Interface)
│   ├── types/                    # Domain types
│   └── utils/                    # Shared utilities
│
└── services/                     # Adapter implementations
    ├── chat/                     # Chat service modules
    │   ├── commands/             # Slash command handling
    │   │   ├── parser.ts         # Parse /help, /new, etc.
    │   │   └── handler.ts        # Execute commands
    │   └── session/              # Session management
    │       ├── manager.ts        # ID generation, logging
    │       └── agent-setup.ts    # MCP connection setup
    ├── chat-service.ts           # Chat orchestrator
    ├── llm/                      # LLM provider adapters
    └── storage/                  # Persistence (JSON file storage)
```

---

## Key Modules After Refactoring

### Agent Runner (`core/agent/`)

The agent runner was decomposed from a 1393-line monolith into focused modules:

| Module                            | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `agent-runner.ts`                 | Orchestrator - delegates to executors                                  |
| `types.ts`                        | Shared types: `AgentRunnerOptions`, `AgentResponse`, `AgentRunContext` |
| `context/summarizer.ts`           | Auto-compaction when context approaches token limit                    |
| `execution/streaming-executor.ts` | Real-time LLM streaming with tool calls                                |
| `execution/batch-executor.ts`     | Non-streaming execution with retry logic                               |

**Dependency Injection Pattern**: To avoid circular dependencies, the `summarizer.ts` accepts a `RecursiveRunner` function parameter instead of importing `AgentRunner` directly.

### Chat Service (`services/chat/`)

The chat service was decomposed from 908 lines into focused modules:

| Module                   | Purpose                                 |
| ------------------------ | --------------------------------------- |
| `chat-service.ts`        | Session orchestrator                    |
| `commands/parser.ts`     | Parse slash commands from user input    |
| `commands/handler.ts`    | Execute individual commands             |
| `commands/types.ts`      | `SpecialCommand`, `CommandResult` types |
| `session/manager.ts`     | Session ID generation, logging          |
| `session/agent-setup.ts` | MCP server connections before chat      |

---

## Common Conventions

### Service Contracts

A service contract is an interface + a Context tag, defined under `src/core/interfaces/`.

```typescript
// src/core/interfaces/agent-config.ts
export interface AgentConfigService {
  getConfig(): Effect.Effect<AgentConfig, Error>;
}

export const AgentConfigServiceTag = Context.GenericTag<AgentConfigService>("AgentConfigService");
```

### Using Services in Effect

```typescript
const config = yield * AgentConfigServiceTag;
const value = yield * config.getConfig();
```

### Providing Layers

```typescript
Layer.effect(AgentConfigServiceTag, Effect.succeed(new ConfigServiceImpl(...)))
```

---

## How to Add a New Adapter/Service

1. Add the contract to `src/core/interfaces/` (interface + Tag).
2. Implement the adapter in `src/services/` and create a Layer.
3. Add registration to `src/main.ts` by merging the new Layer.
4. Add tests with a mock Layer.

---

## Testing Patterns

### Pure Function Tests

For utilities like `parseSpecialCommand` or `generateSessionId`:

```typescript
import { describe, expect, it } from "bun:test";
import { parseSpecialCommand } from "./parser";

describe("parseSpecialCommand", () => {
  it("should parse /help command", () => {
    const result = parseSpecialCommand("/help");
    expect(result.type).toBe("help");
  });
});
```

### Effect Tests with Mocked Layers

```typescript
const mockLogger: LoggerService = {
  debug: () => Effect.void,
  info: () => Effect.void,
  // ...
};

const testLayer = Layer.succeed(LoggerServiceTag, mockLogger);

const result = await Effect.runPromise(myEffect.pipe(Effect.provide(testLayer)));
```

---

## UI Architecture

The CLI uses [Ink](https://github.com/vadimdemedes/ink) (React for terminals) with a dual-pattern state management:

1. **External Store (`store` object)**: Imperative access for Effect-based services
2. **React Context (`AppContext`)**: Reactive state for components

The `ErrorBoundary` component wraps the app to catch rendering errors gracefully.

---

## Why This Structure

- **Separates policy (core) from mechanics (services)** — makes it easy to:
  - Swap LLM providers
  - Substitute storage backends
  - Test core logic with deterministic mocks
- **Good for open-source**: Contributors can implement providers/adapters without changing core logic.

---

## Troubleshooting

- **Missing tag at runtime**: Ensure the Layer providing that tag is included in `createAppLayer`.
- **Circular dependency**: Use dependency injection (pass functions as parameters) instead of direct imports.
- **Context overflow**: The `Summarizer` automatically compacts context when tokens approach 80% of the limit.

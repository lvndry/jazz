# `@jazz/core`

The domain layer of Jazz: agent execution, tool orchestration, and the service contracts
(interfaces) that everything else implements. Zero I/O — no filesystem, network, or terminal
access — which is what makes it independently testable and, eventually, publishable as a
standalone agent SDK.

## Architecture

`@jazz/core` follows Clean/Hexagonal Architecture (Ports & Adapters):

```
┌─────────────────────────────────────────┐
│  @jazz/core                              │
│  - Business logic                        │
│  - Domain models                         │
│  - Service interfaces (ports)            │
│  - Agent execution                       │
└──────┬────────────────────────────────────┘
       │ defines contracts
       │
┌──────▼────────────────────────────────────┐
│  @jazz/adapters                           │
│  - Implements interfaces                  │
│  - External APIs, filesystem, keyring     │
└────────────────────────────────────────────┘
       ▲
       │ composed by
┌──────┴────────────────────────────────────┐
│  @jazz/runtime                            │
│  - Wires core + adapters + cli into an     │
│    Effect Layer graph                      │
└────────────────────────────────────────────┘
```

`@jazz/cli` (Ink/OpenTUI presentation) also depends only on `@jazz/core`; `@jazz/runtime` is the
composition root that ties all three together into the `jazz` binary. The boundary is
structurally enforced via TypeScript project references — `@jazz/core` has no dependency on any
other workspace package, so `tsc -b` rejects an accidental import back out of it.

### Design principles

1. **Dependency rule**: `@jazz/core` depends on nothing else in the workspace. All dependencies
   point inward.
2. **Interfaces are ports**: `@jazz/core` defines contracts (`Context.GenericTag` + interface)
   that `@jazz/adapters` implements as `Layer`s.
3. **Domain logic lives here**: business rules stay independent of frameworks, I/O, and UI.

## Key directories

- **`agent/`** — agent execution logic, context management, prompts, tools, tracking
- **`interfaces/`** — service contracts (ports) that adapters implement
- **`types/`** — domain models and data structures
- **`constants/`** — application-wide constants
- **`utils/`** — shared pure utility functions
- **`workflows/`**, **`skills/`**, **`presentation/`**, **`eval/`** — agent workflow definitions,
  skill loading, presentation-agnostic formatting, and the eval harness

### Interfaces vs types

**`interfaces/`** — service contracts (ports): define _behavior_ infrastructure must implement
(`LLMService`, `StorageService`, `LoggerService`).

**`types/`** — domain models: define the _shape_ of domain data (`Agent`, `ChatMessage`,
`ToolCall`).

Keeping them separate means types describe data while interfaces describe capabilities, and
either can change independently — a new adapter doesn't need a new domain type, and a new domain
field doesn't need a new interface method.

## Adding a new service contract

```typescript
// @jazz/core/interfaces/my-service.ts
export interface MyService {
  doSomething(): Effect.Effect<Result, Error>;
}
export const MyServiceTag = Context.GenericTag<MyService>("MyService");
```

Implement it in `@jazz/adapters`:

```typescript
// @jazz/adapters/my-service.ts
class MyServiceImpl implements MyService {
  doSomething() {
    /* implementation */
  }
}
export const myServiceLayer = Layer.succeed(MyServiceTag, new MyServiceImpl());
```

Wire the layer into the app at `@jazz/runtime/app-layer.ts`.

## What belongs in `@jazz/core`

✅ Pure business logic and domain models — agent execution flow, context window management,
domain types, service interfaces, business rules.

❌ Infrastructure and UI concerns — API clients, filesystem, keyring, terminal rendering, HTTP
requests. Those belong in `@jazz/adapters` or `@jazz/cli`.

## Testing

`@jazz/core` should be highly testable without real I/O:

```typescript
// Test agent-runner by mocking LLMService
const mockLLM = Layer.succeed(LLMServiceTag, {
  createChatCompletion: () => Effect.succeed(mockResponse),
});
```

## Effect-TS usage

- **Async operations**: `Effect.gen` for async workflows
- **Error handling**: tagged errors with recovery strategies
- **Dependency injection**: `Context`/`Layer` for services, resolved at runtime in
  `@jazz/runtime/app-layer.ts`

```typescript
function myLogic(): Effect.Effect<Result, Error, LLMService | LoggerService> {
  return Effect.gen(function* () {
    const llm = yield* LLMServiceTag;
    const logger = yield* LoggerServiceTag;
    // Use services...
  });
}
```

## Related documentation

- **`@jazz/adapters`**: see `packages/adapters/README.md` for interface implementations
- **`@jazz/cli`**: see `packages/cli/README.md` for how commands use core
- **Architecture**: see `docs/ARCHITECTURE.md` for system-wide architecture

**Critical rule**: `@jazz/core` never imports from `@jazz/adapters`, `@jazz/cli`, or
`@jazz/runtime`. All dependencies point inward, and `tsc -b` enforces it.

# Frequently Asked Questions (FAQ)

This FAQ addresses common questions developers have when working with the Jazz codebase, from architecture decisions to practical development workflows.

## Table of Contents

- [Architecture & Design](#architecture--design)
- [Service Implementation](#service-implementation)
- [Effect-TS Patterns](#effect-ts-patterns)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Error Handling](#error-handling)
- [Performance & Optimization](#performance--optimization)
- [Common Pitfalls](#common-pitfalls)

---

## Architecture & Design

### Q: Why put the contract in core?

**A:** Core must depend only on the contract so business logic remains testable and implementation-agnostic. This follows the Dependency Inversion Principle: core defines what it needs (interfaces), and services provide how it's implemented. This separation allows you to:

- Test core logic without real implementations
- Swap implementations (e.g., switch from HTTP to gRPC) without changing core
- Mock services easily in tests

### Q: What's the difference between `core/interfaces/` and `core/types/`?

**A:**

- **`types/`** - Data structures (domain models). These define the _shape_ of data (e.g., `Agent`, `ChatMessage`, `ToolCall`). They represent domain concepts.
- **`interfaces/`** - Service contracts (ports). These define _behavior_ contracts (e.g., `LLMService`, `LoggerService`). They abstract external dependencies.

This separation enforces single responsibility: types describe data, interfaces describe capabilities. It also enables dependency inversion: infrastructure implements interfaces, core defines them.

### Q: Can core import from services?

**A:** **No** Core must never import from `services/` or `cli/`. This is the fundamental dependency rule. All dependencies point inward:

```
services/ → core/ (services implement core interfaces)
cli/ → core/ (CLI uses core logic)
cli/ → services/ (CLI wires services)
```

Core is the heart of the application and must remain pure business logic.

### Q: What if I need to use a service in core but it doesn't exist yet?

**A:** Define the interface first in `core/interfaces/`. You can start with a minimal contract and expand it as you learn more. Even if you don't have the implementation yet, you can:

1. Define the interface with the methods you know you'll need
2. Use the service tag in your core code
3. Create a stub implementation in `services/` that returns safe defaults or throws "not implemented" errors
4. Iterate on both the interface and implementation as you learn

This is better than waiting until you know everything—you can evolve the contract as you build.

### Q: Where do utility functions that wrap service calls belong?

**A:** Utility functions that wrap service calls should live in `src/core/utils/` (or `src/core/agent/` if agent-specific). These are convenience wrappers that use the service tag—they're not part of the service implementation itself.

Example: `isFeatureEnabled()` in `core/utils/feature-flag.ts` wraps `FeatureFlagServiceTag.isEnabled()` for easier usage.

---

## Service Implementation

### Q: What if I want to implement a service but don't know the exact contract before starting?

**A:**

1. **Start with a minimal contract** in `core/interfaces/`:

   ```typescript
   export interface MyService {
     readonly doSomething: (input: string) => Effect.Effect<string, MyServiceError>;
   }
   export const MyServiceTag = Context.GenericTag<MyService>("MyService");
   ```

2. **Create a stub implementation** in `services/`:

   ```typescript
   class StubMyService implements MyService {
     doSomething(input: string) {
       return Effect.fail(new MyServiceError("Not implemented yet"));
     }
   }
   ```

3. **Use it in core** - your core code can already depend on `MyServiceTag` even if it's not fully implemented.

4. **Iterate** - As you build and learn, expand both the interface and implementation. Effect's type system will guide you.

5. **Refactor confidently** - Since core depends only on the contract, you can change the implementation without breaking core logic.

**Pro tip:** Start with the simplest interface that makes your core code compile. You can always add methods later.

### Q: How do I make development easier when building a new service?

**A:** Several strategies:

1. **Use the feature-flag example** (`examples/feature-flag/README.md`) as a template—it shows the complete pattern.

2. **Start with a mock** - Create a simple implementation first:

   ```typescript
   class InMemoryMyService implements MyService {
     private data = new Map();
     doSomething(input: string) {
       return Effect.succeed(this.data.get(input) ?? "default");
     }
   }
   ```

3. **Test in isolation** - Write tests with `Layer.succeed` before wiring into the full app:

   ```typescript
   const mockService = Layer.succeed(MyServiceTag, new InMemoryMyService());
   ```

4. **Log liberally** - Use `LoggerServiceTag` to understand what's happening:

   ```typescript
   const logger = yield * LoggerServiceTag;
   yield * logger.debug("Service called with:", input);
   ```

5. **Incremental integration** - Wire the service into `createAppLayer` only when you're ready to test end-to-end.

### Q: What's the difference between `Layer.provide` and `Layer.mergeAll`?

**A:**

- **`Layer.provide`**: Explicitly provides a dependency to a single layer. Use this when you want explicit control over dependency resolution.

  ```typescript
  const featureFlagLayer = createFeatureFlagLayer().pipe(
    Layer.provide(configLayer), // explicitly provide config
  );
  ```

- **`Layer.mergeAll`**: Combines multiple layers and automatically resolves dependencies between them. Use this when composing the full app layer.
  ```typescript
  return Layer.mergeAll(
    configLayer,
    loggerLayer,
    featureFlagLayer, // dependencies resolved automatically
  );
  ```

**Rule of thumb**: Use `Layer.provide` for explicit control in service factories, use `Layer.mergeAll` in `createAppLayer` for the full composition.

### Q: How do I handle service failures gracefully?

**A:** It depends on whether the service is critical:

**For non-critical services** (like feature flags):

- Return safe defaults (`false`, `0`, empty array)
- Use `Effect.tryPromise` with a catch that returns the default
- Consider adding metrics to detect when services are unavailable

**For critical services** (like LLM):

- Let errors propagate as typed errors
- Use Effect's error recovery mechanisms (`Effect.retry`, `Effect.catchAll`)
- Log errors appropriately
- Provide actionable error messages

Example of graceful degradation:

```typescript
isEnabled(flagName: string) {
  return Effect.tryPromise({
    try: async () => {
      const resp = await fetch(url);
      if (!resp.ok) return false; // fail safe
      return Boolean((await resp.json())?.enabled);
    },
    catch: () => false, // always return false on error
  });
}
```

### Q: Where do I put configuration for a new service?

**A:** Add configuration types to `src/core/types/config.ts` in the `AppConfig` interface. Then:

1. Read config in your service layer:

   ```typescript
   const configService = yield * AgentConfigServiceTag;
   const appConfig = yield * configService.appConfig;
   const myServiceConfig = appConfig.myService;
   ```

2. Provide defaults if config is missing:

   ```typescript
   const baseUrl = myServiceConfig?.baseUrl ?? "https://default.example.com";
   ```

3. Document required config in the service's README or inline comments.

---

## Effect-TS Patterns

### Q: Why use `Effect.gen` instead of async/await?

**A:** `Effect.gen` is Effect-TS's way of handling async operations with dependency injection. It allows you to `yield*` both Effect values and service tags from the context, making dependency injection seamless. It's similar to async/await but with built-in dependency management.

**Key differences:**

- `yield*` extracts values from Effects AND services from context
- Type-safe dependency tracking in function signatures
- Composable and testable (easy to provide mocks)
- Built-in error handling with typed errors

Example:

```typescript
function myFunction(): Effect.Effect<string, Error, LLMService | LoggerService> {
  return Effect.gen(function* () {
    const llm = yield* LLMServiceTag; // get service from context
    const logger = yield* LoggerServiceTag;
    const result = yield* llm.createChatCompletion(...); // yield Effect
    yield* logger.info("Done");
    return result;
  });
}
```

### Q: What does `Effect.Effect<boolean, never>` mean?

**A:** The type parameters are: `Effect<ReturnType, ErrorType, Dependencies>`.

- **`boolean`** - What it returns
- **`never`** - Error type (means it never fails, always succeeds)
- **Dependencies** - Specified via the service tag in the function signature (e.g., `Effect.Effect<boolean, never, FeatureFlagService>`)

**Common patterns:**

- `Effect.Effect<string, Error>` - Returns string, can fail with Error, no dependencies
- `Effect.Effect<void, never, LoggerService>` - Returns void, never fails, requires LoggerService
- `Effect.Effect<Data, DatabaseError, DatabaseService | LoggerService>` - Returns Data, can fail with DatabaseError, requires both services

### Q: How do I handle errors in Effect?

**A:** Effect provides several error handling mechanisms:

1. **Typed errors** - Define specific error types:

   ```typescript
   class MyServiceError extends Data.TaggedError("MyServiceError")<{
     message: string;
   }> {}
   ```

2. **Error recovery** - Use `Effect.catchAll`, `Effect.catchTag`, `Effect.retry`:

   ```typescript
   const result =
     yield *
     myService.doSomething().pipe(
       Effect.catchTag("MyServiceError", (error) => Effect.succeed("fallback value")),
       Effect.retry({ times: 3 }),
     );
   ```

3. **Error mapping** - Transform errors:
   ```typescript
   yield * operation.pipe(Effect.mapError((error) => new UserFriendlyError(error.message)));
   ```

### Q: When should I use `Effect.succeed` vs `Effect.sync` vs `Effect.tryPromise`?

**A:**

- **`Effect.succeed`** - For pure values (no side effects, no computation):

  ```typescript
  Effect.succeed(42);
  ```

- **`Effect.sync`** - For synchronous side effects (throws can become errors):

  ```typescript
  Effect.sync(() => JSON.parse(jsonString));
  ```

- **`Effect.tryPromise`** - For async operations (promise rejections become errors):
  ```typescript
  Effect.tryPromise({
    try: () => fetch(url),
    catch: (error) => new NetworkError(error.message),
  });
  ```

**Rule of thumb**: Use the most specific one. If it's async, use `tryPromise`. If it's sync but can throw, use `sync`. If it's pure, use `succeed`.

### Q: How do I run an Effect in tests?

**A:** Use `Effect.runPromise` or `Effect.runSync`:

```typescript
// Async
const result = await Effect.runPromise(myFunction().pipe(Effect.provide(mockLayer)));

// Sync (only for pure/sync Effects)
const result = Effect.runSync(Effect.succeed(42));
```

Always provide the required dependencies (services) via `Effect.provide` or `Layer.succeed`.

---

## Development Workflow

### Q: How do I debug Effect programs?

**A:**

1. **Use LoggerService** - Log liberally during development:

   ```typescript
   const logger = yield * LoggerServiceTag;
   yield * logger.debug("Debug info:", data);
   ```

2. **Check error types** - Effect's typed errors help identify issues:

   ```typescript
   yield *
     operation.pipe(
       Effect.catchAll((error) => {
         console.error("Error type:", error._tag);
         return Effect.fail(error);
       }),
     );
   ```

3. **Use Effect.tap** - Inspect values without changing them:

   ```typescript
   yield * operation.pipe(Effect.tap((value) => Effect.sync(() => console.log("Value:", value))));
   ```

4. **Run with verbose logging** - Use `--debug` or `--verbose` flags

### Q: What's the development setup?

**A:**

See [CONTRIBUTING.md](../CONTRIBUTING.md) for full details.

### Q: How do I add a new CLI command?

**A:**

1. Create the command function in `src/cli/commands/`:

   ```typescript
   export function myCommand(options: MyOptions) {
     return Effect.gen(function* () {
       // command logic
     });
   }
   ```

2. Register it in `src/main.ts`:

   ```typescript
   program
     .command("my-command")
     .description("Does something")
     .action(() => {
       runCliEffect(myCommand({}));
     });
   ```

3. The command automatically gets access to all services via `createAppLayer()`.

---

## Testing

### Q: How do I mock a service in tests?

**A:** Use `Layer.succeed` to provide a mock implementation:

```typescript
const mockService = {
  isEnabled: (name: string) => Effect.succeed(name === "beta-dashboard"),
  rolloutPercentage: (name: string) => Effect.succeed(50),
};

const mockLayer = Layer.succeed(FeatureFlagServiceTag, mockService);

const result = await Effect.runPromise(myFunction().pipe(Effect.provide(mockLayer)));
```

### Q: Where do I put tests?

**A:**

- **Unit tests**: Co-locate with the code they test (e.g., `my-service.test.ts` next to `my-service.ts`)
- **Integration tests**: In a `tests/` directory or matching structure
- **Example tests**: In `examples/` if testing example code

The project uses Bun for testing, but tests should work with any test runner.

### Q: How do I test Effect programs that depend on multiple services?

**A:** Create a test layer that provides all required services:

```typescript
const testLayer = Layer.mergeAll(
  Layer.succeed(LLMServiceTag, mockLLM),
  Layer.succeed(LoggerServiceTag, mockLogger),
  Layer.succeed(ConfigServiceTag, mockConfig),
);

const result = await Effect.runPromise(myFunction().pipe(Effect.provide(testLayer)));
```

### Q: Should I test the implementation or the interface?

**A:** Both, but differently:

- **Test the interface contract** - Verify that implementations satisfy the contract
- **Test business logic** - Mock interfaces, test core logic in isolation
- **Integration tests** - Test real implementations with real dependencies (when appropriate)

The key is: core logic should be tested with mocked interfaces, implementations should be tested for correctness.

---

## Error Handling

### Q: How do I create custom error types?

**A:** Use Effect's `Data.TaggedError`:

```typescript
import { Data } from "effect";

export class MyServiceError extends Data.TaggedError("MyServiceError")<{
  message: string;
  code?: string;
}> {}
```

Then use it:

```typescript
return Effect.fail(new MyServiceError({ message: "Something went wrong" }));
```

### Q: How do I handle errors at the CLI level?

**A:** Use the error handler in `core/utils/error-handler.ts`. It provides:

- User-friendly error messages
- Actionable suggestions
- Proper exit codes
- Structured error logging

CLI commands automatically use this via `runCliEffect()` in `main.ts`.

### Q: Should services throw or return Effect errors?

**A:** **Always return Effect errors**, never throw. Effect programs should handle errors through the type system:

```typescript
// ✅ Good
return Effect.fail(new MyServiceError({ message: "..." }));

// ❌ Bad
throw new Error("...");
```

This allows:

- Type-safe error handling
- Composable error recovery
- Better testability

---

## Performance & Optimization

### Q: How do I optimize LLM calls?

**A:**

1. **Use streaming** - Stream responses for better perceived performance
2. **Cache when appropriate** - Cache expensive operations
3. **Batch operations** - Combine multiple operations when possible
4. **Lazy evaluation** - Use Effect's lazy evaluation patterns
5. **Monitor token usage** - Track and log token consumption

### Q: How do I handle long-running operations?

**A:**

1. **Use streaming** - For operations that produce output over time
2. **Use Effect.fork** - For truly parallel operations
3. **Provide progress updates** - Use the presentation service to show progress
4. **Handle interruptions** - Use Effect's interruption mechanisms

### Q: Should I worry about Effect performance?

**A:** Generally no—Effect is highly optimized. However:

- Effect programs are lazy and composable, which is efficient
- The type system overhead is compile-time only
- Runtime performance is excellent

If you encounter performance issues, profile first. Effect is rarely the bottleneck.

---

## Common Pitfalls

### Q: I'm getting a "Service not found" error. What's wrong?

**A:** This usually means:

1. The service layer isn't provided in `createAppLayer()`
2. Dependencies aren't satisfied (a service needs another service that isn't provided)
3. The service tag isn't imported correctly

**Check:**

- Is the layer included in `Layer.mergeAll()` in `createAppLayer()`?
- Are all dependencies provided (use `Layer.provide` if needed)?
- Is the tag imported from `core/interfaces/`?

### Q: My Effect program type is too complex. How do I simplify it?

**A:**

1. **Extract dependencies** - Create a type alias for common dependency combinations:

   ```typescript
   type AppDependencies = LLMService | LoggerService | ConfigService;
   ```

2. **Use utility functions** - Wrap common patterns in utilities
3. **Break into smaller functions** - Compose smaller Effects instead of one large one

### Q: I'm confused about when to use `yield*` vs `yield`.

**A:**

- **`yield*`** - For Effects and service tags (most common):

  ```typescript
  const result = yield * someEffect;
  const service = yield * ServiceTag;
  ```

- **`yield`** - Rarely used, only for generator-specific operations

**Rule of thumb**: Always use `yield*` in Effect.gen.

### Q: How do I know if something belongs in core, services, or CLI?

**A:**

- **Core** - Business logic, domain types, service contracts. Pure, testable, no I/O.
- **Services** - Implementations, adapters, external dependencies. Handles I/O, implements core interfaces.
- **CLI** - User interface, presentation, command parsing. Depends on core and services.

**Test**: If you removed the CLI, would the business logic still work? If yes, it's in the right place.

---

## Still Have Questions?

- Check the [Architecture docs](ARCHITECTURE.md)
- Read the layer-specific READMEs:
  - [Core README](../src/core/README.md)
  - [Services README](../src/services/README.md)
  - [CLI README](../src/cli/README.md)
- Look at examples in `examples/feature-flag/README.md`
- Ask in [Discord](https://discord.gg/yBDbS2NZju) or open a [GitHub Discussion](https://github.com/lvndry/jazz/discussions)

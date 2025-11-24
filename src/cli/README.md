# CLI Layer (`src/cli`)

## Overview

The **CLI layer** is the **presentation and entry point** for Jazz. It serves as the bridge between users and the core agent system, handling all user interaction, command parsing, and terminal output while delegating business logic to the core layer.

**Key Responsibilities**:

- User input parsing and validation
- Terminal output and rendering
- Application bootstrapping and dependency wiring
- Interactive prompts and user experience

## Architecture

### Role in the System

The CLI layer follows a **strict separation of concerns**:

```
┌─────────────┐
│   User      │
└──────┬──────┘
       │
┌──────▼─────────────────────────────────┐
│  CLI Layer (src/cli)                    │
│  - Command parsing                      │
│  - User prompts                         │
│  - Output rendering                     │
│  - Error display                        │
└──────┬──────────────────────────────────┘
       │
┌──────▼─────────────────────────────────┐
│  Core Layer (src/core)                  │
│  - Agent execution logic               │
│  - Business rules                      │
│  - Domain models                       │
└──────┬──────────────────────────────────┘
       │
┌──────▼─────────────────────────────────┐
│  Services Layer (src/services)          │
│  - LLM integration                     │
│  - Storage operations                  │
│  - External APIs                       │
└────────────────────────────────────────┘
```

### Design Principles

1. **Presentation Only**: No business logic lives in the CLI layer
2. **Dependency Orchestration**: Wires together core and services using Effect Layers
3. **User Experience First**: Handles all terminal interaction, formatting, and feedback

## Entry Point

The main entry point is `src/main.ts`, which:

1. Parses CLI arguments using Commander.js
2. Loads configuration from files/environment
3. Creates dependency layers (Effect Layers)
4. Executes the requested command with proper error handling

**Command Registration**: Commands are registered in `src/main.ts` using Commander.js's hierarchical command structure.

## Commands

All commands are located in `src/cli/commands/`. Each command is a self-contained module that handles user interaction and delegates to core services.

### Agent Commands

Located in `src/cli/commands/`:

- **`agent chat <identifier>`** (`chat-agent.ts`) - Start an interactive conversation with an AI agent
- **`agent create`** (`chat-agent.ts`) - Create a new agent through an interactive wizard
- **`agent list`** (`task-agent.ts`) - List all configured agents
- **`agent get <id>`** (`task-agent.ts`) - Display details for a specific agent
- **`agent edit <id>`** (`edit-agent.ts`) - Modify an existing agent's configuration
- **`agent delete <id>`** (`task-agent.ts`) - Remove an agent

### Configuration Commands

Located in `src/cli/commands/config.ts`:

- **`config get <key>`** - Get a specific configuration value
- **`config set <key> [value]`** - Set a configuration value
- **`config show`** - Display all configuration values

### Authentication Commands

Located in `src/cli/commands/auth.ts`:

- **`auth gmail login`** - Authenticate with Gmail
- **`auth gmail logout`** - Logout from Gmail
- **`auth gmail status`** - Check Gmail authentication status

### Utility Commands

- **`update`** (`update.ts`) - Check for and install Jazz updates

## Key Concepts

### Command Structure

Each command follows a consistent pattern:

```typescript
// commands/my-command.ts
export function myCommand(options: MyOptions): Effect.Effect<void, JazzError, R> {
  return Effect.gen(function* () {
    // 1. Get dependencies from Effect context
    const service = yield* ServiceTag;

    // 2. Parse/validate user input
    const validated = yield* validateInput(options);

    // 3. Call core business logic
    const result = yield* coreLogic(validated);

    // 4. Display results to user
    yield* displayResult(result);
  });
}
```

Commands are registered in `src/main.ts` and executed with proper dependency injection via Effect Layers.

### Interactive Prompts

Uses `@inquirer/prompts` for user input:

- Agent/model selection
- Configuration wizards
- Confirmations

Example:

```typescript
const agentId = await select({
  message: "Select an agent:",
  choices: agents.map((a) => ({ name: a.name, value: a.id })),
});
```

### Output Rendering

The CLI uses a sophisticated output rendering system (`src/cli/presentation/`) that:

- Auto-detects terminal capabilities (256 colors, 16 colors, or plain text)
- Renders markdown content
- Handles streaming LLM responses
- Shows progress indicators and thinking states

## Development Guide

### Adding a New Command

1. **Create command file** in `src/cli/commands/`

   ```typescript
   // commands/my-command.ts
   export function myCommand(options: MyOptions): Effect.Effect<void, JazzError, R> {
     return Effect.gen(function* () {
       // Implementation using Effect.gen
     });
   }
   ```

2. **Register in `src/main.ts`**

   ```typescript
   program
     .command("my-command")
     .description("Do something")
     .action((options) => {
       const opts = program.opts();
       runCliEffect(
         myCommand(options),
         Boolean(opts["debug"]),
         opts["config"] as string | undefined,
       );
     });
   ```

3. **Use Effect Layers for dependencies**

   Commands receive dependencies through Effect's dependency injection system. The `createAppLayer()` function in `src/main.ts` provides all required services.

### What Belongs in CLI?

✅ **YES** - User interface and presentation

- Command parsing and validation
- Interactive prompts (`@inquirer/prompts`)
- Terminal output and formatting
- Error messages and user feedback
- Help text and documentation

❌ **NO** - Business logic or infrastructure

- Agent execution logic → `src/core/agent/`
- LLM API calls → `src/services/llm/`
- Storage operations → `src/services/storage/`
- Tool implementations → `src/core/agent/tools/`

## Application Bootstrap

The application bootstrap process (`src/main.ts`) handles:

1. **Global Flags**: Parses `--debug`, `--config`, `--verbose`, `--quiet`
2. **Configuration Loading**: Loads from files, environment variables, or CLI args
3. **Dependency Layers**: Creates Effect Layers for all services
4. **Error Handling**: Wraps commands with graceful error handling and user-friendly messages
5. **Signal Handling**: Handles SIGINT/SIGTERM for graceful shutdown

**Dependency Layer Composition**:

```typescript
const appLayer = Layer.mergeAll(
  fileSystemLayer,
  configLayer,
  loggerLayer,
  terminalLayer,
  storageLayer,
  gmailLayer,
  llmLayer,
  toolRegistryLayer,
  // ... more layers
);
```

All commands run within this layer context, providing automatic dependency injection.

## Error Handling

The CLI uses a centralized error handler (`src/core/utils/error-handler.ts`) that:

- Catches all errors (configuration, LLM, tool execution, etc.)
- Provides actionable error messages
- Suggests recovery steps
- Logs detailed information in debug mode

Errors are displayed in a user-friendly format with clear next steps.

## Common Patterns

### Effect-Based Commands

All commands use Effect-TS for:

- **Async Operations**: Effect.gen for async workflows
- **Dependency Injection**: Effect Layers for services
- **Error Handling**: Tagged errors with recovery strategies

```typescript
export function myCommand(id: string): Effect.Effect<void, JazzError, R> {
  return Effect.gen(function* () {
    const service = yield* ServiceTag;
    const result = yield* service.doSomething(id);
    yield* displayResult(result);
  });
}
```

### Streaming Output

For real-time LLM responses, commands use the streaming system:

```typescript
const stream = yield * AgentRunner.runStream({ agent, message });
yield *
  Stream.runForEach(stream, (event) => {
    renderer.handleEvent(event);
  });
```

The output renderer (`src/core/utils/output-renderer.ts`) handles:

- Markdown rendering
- Streaming text display
- Tool execution indicators
- Thinking states for reasoning models

## Testing

### Unit Testing

Mock core services using Effect's testing utilities:

```typescript
const mockLayer = Layer.succeed(ServiceTag, mockService);
const result = await Effect.runPromise(myCommand(options).pipe(Effect.provide(mockLayer)));
```

### Integration Testing

Test full command flows with:

- Real storage (in-memory or temp directories)
- Mocked external services (LLM, Gmail, etc.)
- Output validation
- Error scenario testing

## File Structure

The CLI layer is organized into:

- **`commands/`** - Command implementations for all CLI operations
- **`presentation/`** - Output rendering and formatting utilities

## Related Documentation

- **Core Layer**: See `src/core/README.md` for agent execution logic
- **Services**: See `src/services/README.md` for service implementations
- **Architecture**: See `docs/ARCHITECTURE.md` for system-wide architecture

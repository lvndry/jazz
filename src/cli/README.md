# CLI Layer (`src/cli`)

## Purpose

The **CLI** layer is the **Presentation** and **Entry Point** for the application. It handles:

- User input and command parsing
- Terminal output and rendering
- Application bootstrapping
- Dependency wiring

## Architecture Principles

1. **User Interface**: Handles all user interaction
2. **Dependency Orchestration**: Connects core and services
3. **No Business Logic**: Delegates to core for actual work

## Key Concepts

### Command Pattern

Each command is a separate module:

```typescript
export async function chatWithAIAgentCommand(agentId: string, options: ChatOptions): Promise<void> {
  // 1. Get dependencies (services + core logic)
  // 2. Parse user input
  // 3. Call core business logic
  // 4. Display results
}
```

### Entry Point (`index.ts`)

**Responsibilities**:

1. Parse CLI arguments (using `commander`)
2. Load configuration
3. Wire up dependencies (Effect Layers)
4. Execute requested command

**Flow**:

```
User input → Commander → Command handler → Core logic → Services → External APIs
                                              ↓
                                        Terminal output
```

### Interactive Prompts

Uses `@inquirer/prompts` for user input:

- Agent selection
- Model selection
- Tool selection
- Confirmations

Example:

```typescript
const agentId = await select({
  message: "Select an agent:",
  choices: agents.map((a) => ({
    name: a.name,
    value: a.id,
  })),
});
```

## Commands

### `chat` - Interactive Chat

**Purpose**: Start a conversation with an AI agent

**Flow**:

1. Select/specify agent
2. Load agent configuration
3. Initialize agent runner (core logic)
4. Display streamed responses
5. Handle tool approvals
6. Loop until `/exit`

### `create` - Create Agent

**Purpose**: Guide user through agent creation

**Steps**:

1. Select LLM provider
2. Configure API key (if needed)
3. Select model
4. Choose agent name
5. Add description
6. Select tools
7. Save to storage

### `edit` - Edit Agent

**Purpose**: Modify existing agent configuration

**Options**:

- Rename
- Change model
- Update description
- Add/remove tools

### `list` - List Agents

**Purpose**: Show all configured agents

**Display**:

- Agent ID
- Name
- Model (provider/model)
- Tools

### `list-tools` - List Available Tools

**Purpose**: Show all registered tools by category

**Categories**:

- Email (Gmail)
- Search (Exa, Linkup)
- File System
- Terminal

## Guidelines for Maintainers

### Adding a New Command

1. **Create command file** in `commands/`

   ```typescript
   // commands/my-command.ts
   export async function myCommand(options: MyOptions): Promise<void> {
     // Implementation
   }
   ```

2. **Register in `index.ts`**

   ```typescript
   program.command("my-command").description("Do something").action(myCommand);
   ```

3. **Use core services**
   ```typescript
   const layer = createAppLayer();
   const result = await Effect.runPromise(coreLogic.pipe(Effect.provide(layer)));
   ```

### What Belongs in CLI?

✅ **YES** - User interface and presentation

- Command parsing
- User prompts (inquirer)
- Terminal output
- Error display
- Help text

❌ **NO** - Business logic or infrastructure

- Agent execution logic → `core/agent/`
- LLM API calls → `services/llm/`
- Storage operations → `services/storage/`

### Presentation Components

> **Note**: Presentation utilities currently in `core/utils/` should be moved to `cli/presentation/`:
>
> - `output-renderer.ts`
> - `markdown-renderer.ts`
> - `thinking-renderer.ts`
> - `output-theme.ts`
> - `output-writer.ts`

These handle terminal-specific formatting and are UI concerns, not business logic.

## Application Bootstrap

### Main Entry (`src/main.ts`)

**Responsibilities**:

1. Parse global flags (`--debug`, `--config`)
2. Initialize configuration
3. Set up logging
4. Create dependency layers
5. Execute CLI commands

**Dependency Wiring**:

```typescript
const appLayer = Layer.mergeAll(
  createConfigLayer(debug, customConfigPath),
  createLoggerLayer(),
  createAISDKServiceLayer(),
  createToolRegistryLayer(),
);
```

### Error Handling

Global error handler catches:

- Configuration errors
- LLM errors (auth, rate limits)
- Tool execution failures
- Unexpected errors

Displays user-friendly messages with suggestions.

## Testing CLI Commands

**Unit Tests**: Mock core services

```typescript
const mockAgent = {
  run: () => Effect.succeed({ content: "Hello!" }),
};
```

**Integration Tests**: Test full command flow

- User input simulation
- Output validation
- Storage verification

## Common Patterns

### Effect-Based Commands

Most commands use Effect for:

- Async operations
- Dependency injection
- Error handling

```typescript
const program = Effect.gen(function* () {
  const agent = yield* loadAgent(agentId);
  const result = yield* AgentRunner.run({ agent, ... });
  console.log(result.content);
});

await Effect.runPromise(
  program.pipe(Effect.provide(appLayer))
);
```

### Streaming Output

For real-time LLM responses:

```typescript
const renderer = new OutputRenderer(config);

Stream.runForEach(stream, (event) => renderer.handleEvent(event));
```

## User Experience

### Color Themes

Auto-detect terminal capabilities:

- **Full**: 256 colors + emojis
- **Basic**: 16 colors
- **None**: Plain text

### Progress Indicators

- Thinking indicators for reasoning models
- Tool execution progress
- Streaming status

### Keyboard Shortcuts

- `/exit` - Exit chat
- Ctrl+C - Cancel current operation

## Future Enhancements

Easy to add:

- **New Commands**: Add to `commands/`, register in `index.ts`
- **Rich TUI**: Upgrade to `ink` for React-based terminal UI
- **Configuration Wizard**: Interactive setup
- **Plugins**: Command plugins loaded dynamically

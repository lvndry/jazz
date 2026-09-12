# `@jazz/cli`

Terminal presentation and command implementations for Jazz. Commander registration and process wiring live in `@jazz/runtime`; agent policy and execution live in `@jazz/core`.

## What belongs here

- interactive chat session management;
- command effects for agents, personas, config, workflows, peers, runs, MCP, and bridges;
- the full-screen OpenTUI interface and terminal input handling;
- plain and one-shot presentation services;
- formatting, progress, approvals, questions, and file pickers.

## Find the implementation

- `src/commands/`: command effects called by the runtime command tree
- `src/chat/`: interactive sessions and slash-command handling
- `src/ui/fullscreen/`: the current full-screen terminal interface
- `src/ui/`: shared terminal components and state
- `src/presentation/`: rendering for non-full-screen modes
- `src/services/`: terminal-facing service implementations

Add a command implementation here, then register its public syntax in `packages/runtime/src/cli-app.ts`. Keep business rules in core and external clients or persistence in adapters.

For user-facing syntax, read the [command index](../../docs/commands.md). For ownership and wiring, read the [architecture guide](../../docs/maintainers/architecture.md).

## Adding a command

Two files, in this order.

**1. The effect, here.** A command is a function returning an `Effect` that depends on services
rather than constructing them:

```typescript
// src/commands/my-command.ts
export function myCommand(name: string): Effect.Effect<void, JazzError, TerminalService> {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    yield* terminal.log(`hello ${name}`);
  });
}
```

**2. The syntax, in the runtime.** `packages/runtime/src/cli-app.ts` owns the Commander tree and
nothing else:

```typescript
program
  .command("my-command <name>")
  .description("Say hello")
  .action((name: string) =>
    runCliAction(
      () => import("@jazz/cli/commands/my-command").then((m) => m.myCommand(name)),
      cliRuntimeOptions(program),
    ),
  );
```

The dynamic `import()` is not stylistic. Actions load the agent stack only when a command
actually runs, which is what keeps `jazz --help` and `jazz --version` on the Commander tree
alone. A static import at the top of `cli-app.ts` pulls Effect and the tool registry into every
invocation and costs roughly 150ms on all of them.

`docs/commands.md` is checked against this tree by `cli-docs.test.ts`, so a new command fails the
docs test until it is documented.

## What belongs where

| Belongs here                                 | Belongs elsewhere                                |
| -------------------------------------------- | ------------------------------------------------ |
| Prompts, formatting, progress, approvals     | Agent execution and policy → `@jazz/core/agent/` |
| Command effects and their user-facing errors | LLM clients → `@jazz/adapters/llm/`              |
| The full-screen interface and input handling | Storage and keyring → `@jazz/adapters/`          |
| Anything a terminal is required to do        | Tool implementations → `@jazz/core/agent/tools/` |

The test is whether a chat bridge or the daemon would need it. If yes, it is not presentation and
does not belong in this package.

## Testing

Command effects are tested by providing stub service layers, with no process and no terminal:

```typescript
const layer = Layer.succeed(TerminalServiceTag, fakeTerminal);
await Effect.runPromise(myCommand("world").pipe(Effect.provide(layer)));
```

`cli-app.test.ts` covers the Commander tree itself: flags parse, subcommands exist, and the
docs match.

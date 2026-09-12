# `@jazz/cli`

Terminal presentation and command implementations for Jazz. Commander registration and process wiring live in `@jazz/runtime`; agent policy and execution live in `@jazz/core`.

## What belongs here

- interactive chat session management;
- command effects for agents, personas, config, workflows, peers, runs, MCP, and bridges;
- the full-screen OpenTUI interface and terminal input handling;
- plain and one-shot presentation services;
- formatting, progress, approvals, questions, and file pickers.

## Find the implementation

- `src/commands/` — command effects called by the runtime command tree
- `src/chat/` — interactive sessions and slash-command handling
- `src/ui/fullscreen/` — the current full-screen terminal interface
- `src/ui/` — shared terminal components and state
- `src/presentation/` — rendering for non-full-screen modes
- `src/services/` — terminal-facing service implementations

Add a command implementation here, then register its public syntax in `packages/runtime/src/cli-app.ts`. Keep business rules in core and external clients or persistence in adapters.

For user-facing syntax, read the [command index](../../docs/commands.md). For ownership and wiring, read the [architecture guide](../../docs/maintainers/architecture.md).

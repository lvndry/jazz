# `@jazz/adapters`

Infrastructure implementations for the service contracts in `@jazz/core`. This package owns external I/O; it does not own agent policy.

## What belongs here

- model-provider integration and model metadata;
- configuration loading and keyring-backed secrets;
- filesystem, conversation, run, memory, and workspace persistence;
- MCP clients and trust metadata;
- daemon HTTP handling, job queues, reminders, peers, and webhooks;
- telemetry and desktop notifications.

`@jazz/core` defines each service interface and `Context` tag. An adapter implements that contract as an Effect `Layer`; `@jazz/runtime` composes it into the application.

## Find the implementation

- `src/llm/` — AI SDK providers, model catalog, attachments, and reasoning normalization
- `src/storage/` and `src/history/` — file-backed state and conversations
- `src/mcp/` — MCP connection, OAuth, elicitation, and server lifecycle
- `src/daemon/` — authenticated HTTP server and unattended run handling
- `src/peers/` and `src/webhooks/` — remote agent and fixed-prompt boundaries
- `src/telemetry/` — local and OTLP sinks
- `src/config.ts` — global/project configuration merge and secret routing

Tests live beside the implementation. Use temporary directories and test Layers; never depend on a developer's real Jazz home, keyring, provider account, or daemon.

For package boundaries and the service-extension path, read the [architecture guide](../../docs/maintainers/architecture.md) and [add a service](../../docs/maintainers/add-a-service.md).

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

- `src/llm/`: AI SDK providers, model catalog, attachments, and reasoning normalization
- `src/storage/` and `src/history/`: file-backed state and conversations
- `src/mcp/`: MCP connection, OAuth, elicitation, and server lifecycle
- `src/daemon/`: authenticated HTTP server and unattended run handling
- `src/peers/` and `src/webhooks/`: remote agent and fixed-prompt boundaries
- `src/telemetry/`: local and OTLP sinks
- `src/config.ts`: global/project configuration merge and secret routing

Tests live beside the implementation. Use temporary directories and test Layers; never depend on a developer's real Jazz home, keyring, provider account, or daemon.

For package boundaries and the service-extension path, read the [architecture guide](../../docs/maintainers/architecture.md) and [add a service](../../docs/maintainers/add-a-service.md).

## The shape of an adapter

Three pieces, always in this order. The contract lives in core, the implementation lives here,
and the wiring lives in the runtime:

```typescript
// @jazz/core/interfaces/thing.ts: the contract, and the tag
export interface ThingService {
  readonly fetch: (id: string) => Effect.Effect<Thing, ThingError>;
}
export const ThingServiceTag = Context.GenericTag<ThingService>("ThingService");

// @jazz/adapters/thing/http-thing.ts: one implementation
export const HttpThingServiceLive = Layer.succeed(ThingServiceTag, {
  fetch: (id) => Effect.tryPromise({ try: () => api.get(id), catch: toThingError }),
});
```

Core depends on the tag and never on this package, which is what lets a test swap the whole
adapter for `Layer.succeed(ThingServiceTag, stub)` and what keeps agent policy testable without
a network, a keyring, or a disk.

The full walkthrough, including error types and wiring into `createAppLayer`, is
[add a service](../../docs/maintainers/add-a-service.md). For providers specifically, see
[add a model provider](../../docs/maintainers/add-a-provider.md).

## Rules that are not style

- **Never import from `@jazz/cli` or `@jazz/runtime`.** Dependencies point inward. An adapter
  that needs to ask the user something takes a service that can, rather than reaching for a
  terminal.
- **Secrets go through the keyring path**, never into `config.json` and never into a log line.
  `src/secrets/registry.ts` is the single source of truth for which config paths hold one.
- **Failure is a value.** Return a typed error in the Effect channel rather than throwing; the
  caller decides whether an unreachable provider is fatal.
- **Tests use temporary directories and stub layers.** Never a developer's real Jazz home,
  keyring, provider account, or daemon.

# `@jazz/runtime`

The composition root: wires `@jazz/core`, `@jazz/adapters`, and `@jazz/cli` together into the
running `jazz` CLI, and is what `scripts/build.ts` compiles into the standalone binary.

## Role in the system

```
┌─────────────┐
│   User      │
└──────┬──────┘
       │
┌──────▼──────────────────────────────────┐
│  @jazz/runtime                           │
│  - Process bootstrap (entry.ts)          │
│  - Commander.js program (cli-app.ts)     │
│  - Effect Layer composition (app-layer)  │
└──────┬──────────────────────────────────┘
       │ provides layers to
┌──────▼──────────────────────────────────┐
│  @jazz/cli                               │
└──────┬──────────────────────────────────┘
       │ calls
┌──────▼──────────────────────────────────┐
│  @jazz/core                              │
└──────▲──────────────────────────────────┘
       │ implements
┌──────┴──────────────────────────────────┐
│  @jazz/adapters                          │
└───────────────────────────────────────────┘
```

`@jazz/runtime` is the only package allowed to depend on all three of `core`, `adapters`, and
`cli` at once — everywhere else, the dependency rule points inward (see
`docs/internals/code-map.md`).

## Key files

- **`entry.ts`** — process-level bootstrap (suppresses noisy deprecation warnings) before the
  rest of the app loads. This is the binary's actual entrypoint.
- **`main.ts`** — second-stage entrypoint imported by `entry.ts`; builds the Commander program
  and parses `argv`. Also routes the `ai` SDK's warning logger to stderr, since `jazz run --json`
  requires stdout to be JSON-only.
- **`cli-app.ts`** — Commander.js setup and command registration for every `jazz <command>`.
- **`app-layer.ts`** — builds the Effect `Layer` that wires every adapter (storage, LLM,
  terminal, presentation, telemetry, ...) behind `@jazz/core`'s service tags, then runs a
  command's effect against it. This is where a new service's `Layer` gets registered.

## Adding a new command

1. Implement it in `@jazz/cli/commands/<name>.ts` (see `packages/cli/README.md`).
2. Register it in `cli-app.ts`'s Commander program.
3. If it needs a new service, define the contract in `@jazz/core/interfaces/`, implement it in
   `@jazz/adapters/`, and add its `Layer` to `app-layer.ts`'s `createAppLayer()`.

## Related documentation

- **Core**: `packages/core/README.md`
- **Adapters**: `packages/adapters/README.md`
- **CLI**: `packages/cli/README.md`
- **Architecture**: `docs/reference/architecture.md`

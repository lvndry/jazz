# Jazz — Architecture Overview

This document is a short, practical guide to the code organization and architectural conventions used in Jazz. It's focused on what contributors need to know to add features, implement adapters, and write tests.

Core principles

- core/ contains the domain, contracts (interfaces and types), and business logic.
  - No imports from services/ allowed in core/ except in tests.
  - Contracts are expressed as interfaces + Context tags (e.g. `AgentConfigServiceTag`).
- services/ implements adapters (database, LLM providers, Gmail, file system, logger, etc.).
  - Services provide Layers that satisfy the tags declared in core/interfaces.
- cli/ contains user-facing command implementations and presentation code.

Key directories

- src/core: domain and contracts
  - src/core/interfaces: service contracts (tags + interfaces)
  - src/core/types: domain types used by core logic
  - src/core/agent: core agent execution logic and tools
- src/services: concrete implementations (adapters) and Layer factories
- src/cli: CLI commands and presentation

Common conventions

- A service contract is an interface + a Context tag, defined under `src/core/interfaces`.
  - Example: `src/core/interfaces/agent-config.ts` defines `AgentConfigService` and `AgentConfigServiceTag`.
- Service implementations import the contract tag and provide a Layer:
  - `Layer.effect(AgentConfigServiceTag, Effect.succeed(new ConfigServiceImpl(...)))`
- Core logic depends only on the contract (tag) and types in core/types.
  - To use a service inside an Effect generator, use `const cfg = yield* AgentConfigServiceTag;`
- Tools (invokable functions available to agents) live in `src/core/agent/tools` and depend on lightweight interfaces (e.g., FileSystemContextServiceTag) from core/interfaces.

How to add a new adapter/service

1. Add the contract to `src/core/interfaces` (interface + Tag).
2. Implement the adapter in `src/services` and create a Layer that provides the contract tag.
3. Add registration to `src/main.ts` by merging the new Layer into the application layer composition.
4. Add tests with a small mock Layer or use the real Layer in integration tests.

Testing & layers

- Use `Layer.succeed(TAG, mock)` to provide mock implementations during tests.
- Where convenient, reuse existing helper mocks in `src/test` or `tests/helpers` (if present).

Why this structure

- Separates policy (core) from mechanics (services) — makes it easier to:
  - swap LLM providers
  - substitute storage backends (in-memory vs file vs DB)
  - test core logic with deterministic mocks
- Good for open-source: external contributors can implement providers/adapters without changing core logic.

Troubleshooting

- If TypeScript reports a missing tag at runtime, ensure the Layer providing that tag is included in `createAppLayer` or in the tests.
- Prefer moving any service-specific helper into `src/services` and adding a small contract to `src/core/interfaces` if core needs to depend on it.

If you'd like, I can expand this into a short CONTRIBUTING section with examples for writing tests and implementing providers.

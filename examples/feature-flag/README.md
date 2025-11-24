# Feature Flag Service — Example Template

This example is a self-contained template showing how to design, implement, wire, and test a simple FeatureFlagService following the project architecture:

- Contract (core) — `src/core/interfaces` (interface + Tag)
- Adapter (services) — `src/services` (implementation + Layer)
- App wiring — layer composition in `createAppLayer` (main)
- Tests — how to mock the service with `Layer.succeed`

IMPORTANT: This example lives under `examples/` only and is intended as a reference/template. Do NOT copy this file into production code paths without review.

---

Table of contents

- Overview
- 1. Contract: core interface (example)
- 2. Adapter: HTTP-backed example implementation (template)
- 3. Wiring: add the layer to `createAppLayer` (example)
- 4. Usage: how core and CLI access the service
- 5. Testing: unit test example using `Layer.succeed`
- 6. Notes, safety, and checklist

---

Overview

Feature flags are a common cross-cutting concern. The pattern below shows how to:

1. Define a small contract in `core` that core business logic depends on.
2. Implement the contract in `services` as a Layer that can depend on configuration/logger/etc.
3. Provide the Layer in app composition so core code can call the contract via its Tag.
4. Mock the contract in tests with `Layer.succeed`.

---

1. Contract — core interface

Place this under `src/core/interfaces/feature-flag.ts` in your real codebase. In this example it's shown inline.

```ts
// src/core/interfaces/feature-flag.ts — example
import { Context, Effect } from "effect";

export interface FeatureFlagService {
  // return true/false for a named flag
  // Effect.Effect<boolean, never> means: returns boolean, never fails (always succeeds)
  readonly isEnabled: (flagName: string) => Effect.Effect<boolean, never>;

  // optional: get rollout percentage (0..100)
  readonly rolloutPercentage: (flagName: string) => Effect.Effect<number, never>;
}

// Context.GenericTag creates a dependency injection token
// This tag is used to access the service via Effect's dependency system
export const FeatureFlagServiceTag = Context.GenericTag<FeatureFlagService>("FeatureFlagService");
```

Design guidance

- Keep the contract small and focused.
- Prefer safe return types (boolean/number) for non-critical features — allow graceful degradation.
- Put contracts in `src/core/interfaces` so the core layer depends only on the contract.
- Use `Effect.Effect<ReturnType, ErrorType, Dependencies>`:
  - `ReturnType`: what the function returns (boolean, number, etc.)
  - `ErrorType`: error types it can fail with (`never` means it never fails)
  - `Dependencies`: services it needs (omitted here, added via Tag in usage)

---

2. Adapter — HTTP-backed example (template)

This is an example service implementation showing:

- How to read configuration via AgentConfigService
- How to build a Layer that depends on the config tag
- How to implement safe fallbacks

Place something like this under `src/services/feature-flag/http.ts` in your real project (here we show the template).

```ts
// src/services/feature-flag/http.ts
import { Effect, Layer } from "effect";
import { FeatureFlagServiceTag, type FeatureFlagService } from "../../core/interfaces/feature-flag";
import { AgentConfigServiceTag, type AgentConfigService } from "../../core/interfaces/agent-config";

class HTTPFeatureFlagService implements FeatureFlagService {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
  ) {}

  isEnabled(flagName: string) {
    return Effect.tryPromise({
      try: async () => {
        const url = `${this.baseUrl.replace(/\/$/, "")}/flags/${encodeURIComponent(flagName)}/enabled`;
        const resp = await fetch(url, {
          headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
        });
        if (!resp.ok) {
          // degrade safely
          return false;
        }
        const body = await resp.json();
        return Boolean(body?.enabled);
      },
      catch: () => false,
    });
  }

  rolloutPercentage(flagName: string) {
    return Effect.tryPromise({
      try: async () => {
        const url = `${this.baseUrl.replace(/\/$/, "")}/flags/${encodeURIComponent(flagName)}`;
        const resp = await fetch(url, {
          headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
        });
        if (!resp.ok) return 0;
        const body = await resp.json();
        const value = typeof body?.rollout === "number" ? body.rollout : 0;
        return Math.max(0, Math.min(100, value));
      },
      catch: () => 0,
    });
  }
}

export function createHTTPFeatureFlagLayer(): Layer.Layer<
  FeatureFlagService,
  never,
  AgentConfigService
> {
  return Layer.effect(
    FeatureFlagServiceTag,
    Effect.gen(function* () {
      const configService = yield* AgentConfigServiceTag;
      const appConfig = yield* configService.appConfig; // AppConfig should include a featureFlags section
      const baseUrl = appConfig.featureFlags?.baseUrl ?? "https://flags.example.com";
      const apiKey = appConfig.featureFlags?.apiKey;
      return new HTTPFeatureFlagService(baseUrl, apiKey);
    }),
  );
}
```

Notes:

- The Layer declares it requires `AgentConfigService` so it can read configuration (see the type parameter `AgentConfigService` in the return type).
- `Effect.tryPromise` wraps async operations and converts promise rejections to Effect errors. Here we catch all errors and return safe defaults (`false`/`0`) to avoid breaking the app if the flag service is unavailable.
- The Layer type `Layer.Layer<FeatureFlagService, never, AgentConfigService>` means:
  - Provides: `FeatureFlagService` (what this layer gives you)
  - Errors: `never` (this layer creation never fails)
  - Requires: `AgentConfigService` (what this layer needs to be created)

---

3. Wiring — provide the layer in createAppLayer (example)

In your app bootstrap (e.g., `src/main.ts`) you compose layers. Example snippet:

```ts
import { Layer } from "effect";
import { createConfigLayer } from "./services/config"; // provides AgentConfigServiceTag
import { createLoggerLayer } from "./services/logger";
import { createHTTPFeatureFlagLayer } from "./services/feature-flag/http";

function createAppLayer() {
  const configLayer = createConfigLayer(); // provides AgentConfigServiceTag
  const loggerLayer = createLoggerLayer();

  // feature flag layer depends on AgentConfigService; provide configLayer first
  const featureFlagLayer = createHTTPFeatureFlagLayer().pipe(Layer.provide(configLayer));

  return Layer.mergeAll(
    configLayer,
    loggerLayer,
    featureFlagLayer,
    // ...other layers
  );
}
```

Important:

- **Layer dependencies**: The FeatureFlag layer requires `AgentConfigService`, so you must provide it before using the layer.
- **Two ways to provide dependencies**:
  1. `Layer.provide`: Explicitly provide a dependency to a single layer (as shown above)
  2. `Layer.mergeAll`: Merge multiple layers together; dependencies are resolved automatically if all required layers are included
- **Ordering matters**: When using `Layer.provide`, provide dependencies before the layer that needs them. When using `Layer.mergeAll`, include all required layers in the merge.

---

4. Usage — how core and CLI access the service

**Architecture overview**:

- **Services** implement core interfaces (services depend on core) — services are the concrete implementations
- **Core** and **CLI** access services through dependency injection via tags — they use the service without knowing the implementation

Both **core** and **CLI** layers can use the service by:

1. Importing the Tag from `core/interfaces`
2. Accessing it via `yield*` inside an `Effect.gen` block
3. Calling methods on the service

**Creating utility functions**:

Utility functions that wrap service calls should live in `src/core/utils/` (or `src/core/agent/` if agent-specific). These are convenience wrappers that use the service tag — they're not part of the service implementation itself.

````ts
// src/core/utils/feature-flag.ts
import { Effect } from "effect";
import { FeatureFlagServiceTag, type FeatureFlagService } from "../interfaces/feature-flag";

/**
 * Check if a feature flag is enabled.
 *
 * @param flagName - The name of the feature flag to check
 * @returns An Effect that resolves to true if enabled, false otherwise
 *
 * @example
 * ```ts
 * const enabled = yield* isFeatureEnabled("new-ui");
 * if (enabled) {
 *   // use new UI
 * }
 * ```
 */
export function isFeatureEnabled(
  flagName: string,
): Effect.Effect<boolean, never, FeatureFlagService> {
  return Effect.gen(function* () {
    // yield* extracts the service from the Effect context
    const flags = yield* FeatureFlagServiceTag;
    // Call the service method
    return yield* flags.isEnabled(flagName);
  });
}

// Alternative: if you want a function that conditionally runs code
export function whenFeatureEnabled<T>(
  flagName: string,
  whenEnabled: () => Effect.Effect<T, never, FeatureFlagService>,
  whenDisabled?: () => Effect.Effect<T, never, FeatureFlagService>,
): Effect.Effect<T, never, FeatureFlagService> {
  return Effect.gen(function* () {
    const enabled = yield* isFeatureEnabled(flagName);
    if (enabled) {
      return yield* whenEnabled();
    } else if (whenDisabled) {
      return yield* whenDisabled();
    }
    return undefined as T;
  });
}
````

**Usage examples**:

**In core code** (`src/core/agent/agent-runner.ts`):

```ts
import { Effect } from "effect";
import { isFeatureEnabled } from "../utils/feature-flag";

// Use the utility in core business logic
export function executeAgent(agentId: string) {
  return Effect.gen(function* () {
    // Effect.gen is Effect's equivalent of async/await
    // yield* extracts values from Effects and services from the context
    const enabled = yield* isFeatureEnabled("new-agent-strategy");

    if (enabled) {
      yield* runNewStrategy(agentId); // new feature path
    } else {
      yield* runLegacyStrategy(agentId); // fallback path
    }
  });
}
```

**In CLI code** (`src/cli/commands/chat-agent.ts`):

```ts
import { Effect } from "effect";
import { isFeatureEnabled } from "../../core/utils/feature-flag";

export function chatWithAIAgentCommand(agentId: string) {
  return Effect.gen(function* () {
    // Check feature flag in CLI command
    const useNewUI = yield* isFeatureEnabled("new-chat-ui");

    if (useNewUI) {
      yield* renderNewChatInterface(agentId);
    } else {
      yield* renderLegacyChatInterface(agentId);
    }
  });
}
```

**Using the conditional runner** (alternative pattern):

```ts
import { whenFeatureEnabled } from "../utils/feature-flag";

export function executeAgent(agentId: string) {
  return whenFeatureEnabled(
    "new-agent-strategy",
    () => runNewStrategy(agentId), // when enabled
    () => runLegacyStrategy(agentId), // when disabled
  );
}
```

**Direct usage** (without the utility):

You can also use the service directly without a utility function:

```ts
// In core/ or cli/ code
import { Effect } from "effect";
import { FeatureFlagServiceTag } from "../interfaces/feature-flag";

const program = Effect.gen(function* () {
  // Access the service directly via its tag
  const flags = yield* FeatureFlagServiceTag;
  // Call the service method
  const enabled = yield* flags.isEnabled("new-feature");
  if (enabled) {
    // feature is enabled
  }
});

// Run the program with the app layer that provides FeatureFlagService
const result = yield * program.pipe(Effect.provide(appLayer));
```

---

5. Testing — mock the service with Layer.succeed

Unit tests should not call the remote flag service. Provide a mock implementation with `Layer.succeed`.

```ts
// examples/feature-flag/tests/feature-flag.spec.ts
import { describe, it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { FeatureFlagServiceTag } from "../../src/core/interfaces/feature-flag"; // path depends on test runner

const mockService = {
  isEnabled: (name: string) => Effect.succeed(name === "beta-dashboard"),
  rolloutPercentage: (name: string) => Effect.succeed(50),
};

it("uses mocked feature flag", async () => {
  const program = Effect.gen(function* () {
    const flags = yield* FeatureFlagServiceTag;
    return yield* flags.isEnabled("beta-dashboard");
  });

  const result = await Effect.runPromise(
    program.pipe(Effect.provide(Layer.succeed(FeatureFlagServiceTag, mockService))),
  );
  expect(result).toBe(true);
});
```

Notes:

- **`Layer.succeed`**: Provides a mock service implementation directly. This is the simplest way to mock services in tests.
- **Test isolation**: Unit tests should never call external services. Always mock with `Layer.succeed` or similar.
- **Integration tests**: For integration tests, provide the real layer (from `createAppLayer`) but run against a test flag service or use a local stub server.
- **Effect.provide**: This pipes the mock layer into your program, making the service available in the Effect context.

---

6. Notes, safety, and checklist

Checklist before copying into production `src/`:

- [ ] Add configuration types to `src/core/types/config.ts` (featureFlags config block)
- [ ] Add typed errors in `src/core/types/errors.ts` if the service needs to surface structured failures
- [ ] Use LoggerServiceTag for structured logging inside the service (instead of console)
- [ ] Add unit tests and, optionally, integration tests that run against a test flag server
- [ ] Ensure no secrets (API keys) are committed to the repo — use env variables or secure stores
- [ ] Ensure feature-flag calls are safe and fail closed or open according to product policy (this example fails safe to `false`)

## FAQ

**Q: What if feature flags are not critical and their failure shouldn't break the app?**  
A: Use conservative defaults (false/0) to avoid unexpected behavior. Consider adding metrics to detect when flags are unavailable.

For detailed answers to common questions about architecture, Effect-TS patterns, testing, and development workflow, see the [FAQ in the docs](../docs/FAQ.md).

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
- 4. Usage: how core code accesses the service
- 5. Testing: unit test example using `Layer.succeed`
- 6. Notes, safety, and checklist

---

Overview

Feature flags are a common cross-cutting concern. The pattern below shows how to:

1. Define a small contract in `core` that core business logic depends on.
2. Implement the contract in `services` as a Layer that can depend on configuration/logger/etc.
3. Provide the Layer in app composition so core code can call the contract via its Tag.
4. Mock the contract in tests with `Layer.succeed`.

All code below is example/template code intended for copy-and-adapt.

---

1. Contract — core interface

Place this under `src/core/interfaces/feature-flag.ts` in your real codebase. In this example it's shown inline.

```ts
// src/core/interfaces/feature-flag.ts — example
import { Context, Effect } from "effect";

export interface FeatureFlagService {
  // return true/false for a named flag
  readonly isEnabled: (flagName: string) => Effect.Effect<boolean, never>;

  // optional: get rollout percentage (0..100)
  readonly rolloutPercentage: (flagName: string) => Effect.Effect<number, never>;
}

export const FeatureFlagServiceTag = Context.GenericTag<FeatureFlagService>("FeatureFlagService");
```

Design guidance

- Keep the contract small and focused.
- Prefer safe return types (boolean/number) for non-critical features — allow graceful degradation.
- Put contracts in `src/core/interfaces` so the core layer depends only on the contract.

---

2. Adapter — HTTP-backed example (template)

This is an example service implementation showing:

- How to read configuration via AgentConfigService
- How to build a Layer that depends on the config tag
- How to implement safe fallbacks

Place something like this under `src/services/feature-flag/http.ts` in your real project (here we show the template).

```ts
// src/services/feature-flag/http.ts — example template
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

- The Layer declares it requires `AgentConfigService` so it can read configuration.
- `Effect.tryPromise` is used with conservative defaults to avoid failing the entire application if the flag service is unavailable.

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

- Ordering matters: if FeatureFlag layer depends on AgentConfigService, supply configLayer before it (use Layer.provide or ensure configLayer appears earlier in merge order).

---

4. Usage — how core code accesses the service

Core code only imports the Tag from core/interfaces and uses Effect to access it. Example:

```ts
import { Effect } from "effect";
import { FeatureFlagServiceTag } from "../interfaces/feature-flag";

export function runIfFeatureEnabled(flagName: string) {
  return Effect.gen(function* () {
    const flags = yield* FeatureFlagServiceTag;
    const enabled = yield* flags.isEnabled(flagName);
    if (enabled) {
      // run the feature-path
    } else {
      // fallback path
    }
  });
}
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

- Use `Layer.succeed` to provide lightweight, deterministic mocks.
- For integration tests, provide the real layer but run against a test flag service or use a local stub server.

---

6. Notes, safety, and checklist

Checklist before copying into production `src/`:

- [ ] Add configuration types to `src/core/types/config.ts` (featureFlags config block)
- [ ] Add typed errors in `src/core/types/errors.ts` if the service needs to surface structured failures
- [ ] Use LoggerServiceTag for structured logging inside the service (instead of console)
- [ ] Add unit tests and, optionally, integration tests that run against a test flag server
- [ ] Ensure no secrets (API keys) are committed to the repo — use env variables or secure stores
- [ ] Ensure feature-flag calls are safe and fail closed or open according to product policy (this example fails safe to `false`)

Security & safety

- Example code uses `fetch` as a placeholder. Use a proper HTTP client if you need retries, timeouts, and tracing.
- Do not embed API keys in source. Use config files or environment variables and ensure the repo does not include secrets.

FAQ

Q: Why put the contract in core?
A: Core must depend only on the contract so business logic remains testable and implementation-agnostic.

Q: What if feature flags are not critical and their failure shouldn't break the app?
A: Use conservative defaults (false/0) to avoid unexpected behavior. Consider adding metrics to detect when flags are unavailable.

Q: Where do I put the tests for the example?
A: Tests live under `tests/` or a matching structure in `examples/` as shown. In your app, co-locate unit tests next to the code they exercise.

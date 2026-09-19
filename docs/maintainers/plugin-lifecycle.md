---
description: "Maintain Jazz's trusted in-process plugin lifecycle, per-run sessions, digest store, consent boundary, and advisory routing hook."
---

# Plugin lifecycle

Jazz's plugin runtime is a ports-and-adapters feature. Core owns the ABI-facing domain contracts,
non-failing advisory runner, consent digest, and service tags. Adapters own manifest parsing,
downloads, filesystem state, dynamic import, keyring access, and module-session construction. The
CLI owns local operator confirmation, and runtime wires the layers.

## State machine

```text
catalog/local manifest
  -> installed (verified bytes; never imported)
  -> trusted (exact code digest)
  -> consented (code + hooks + destinations + data classes)
  -> enabled for one agent
  -> lazily imported into that agent run's PluginSession
```

Every transition takes `$JAZZ_HOME/plugins/.state.lock`. The artifact is written and verified before
one atomic state-document replacement makes it current. An incompatible state schema fails closed;
repair is explicit and must not silently erase grants or rollback artifacts.

The module is imported only after the current lock has valid trust, consent, and agent enablement.
Registration is synchronous and sealed on return. Hook/provider registrations are session-local so
concurrent agents cannot overwrite one another. Session disposal is best effort only: in-process ESM
cannot be unloaded.

## Advisory dispatch

`route.skills` runs for a fresh, top-level request after skill discovery and before the first model
call. The host validates a probability distribution over the live roster plus explicit no-skill
mass, then applies host policy. Plugin-produced prose is never injected.

The resulting host-rendered hint rides on the agent loop's iteration-zero provider-only message
copy. It never enters canonical messages, persistence, resume state, work state, logs, or telemetry.
Disabled or absent plugins leave provider messages byte-equivalent to the previous behavior.

Promise rejection, schema failure, cooperative timeout, missing secrets, and unavailable providers
all become abstention. `AbortSignal` and Effect interruption cannot stop synchronous loops,
`process.exit()`, or code that ignores cancellation; the local trust disclosure must remain explicit
about that limit.

## Distribution checks

The author packer uses Bun with package bundling enabled, splitting disabled, and unresolved imports
forbidden. It accepts exactly one JavaScript output and rejects native modules, WASM, emitted assets,
and remaining runtime imports. Tests must load the identical digest-addressed artifact through both
the development runtime and every standalone release target.

Routing component metrics live under `evals/skill-routing/`. The raw-request lexical scorer is a
proxy, not the current Jazz product baseline. Activation requires paired end-to-end A/B evidence for
actual skill loads and task success, plus latency, failure, false-positive, and cost gates on a held
test split.

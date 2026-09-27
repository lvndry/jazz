---
description: "Maintain Jazz's trusted in-process plugin lifecycle, per-run sessions, digest store, consent boundary, advisory routing, and command-risk policy hook."
---

# Plugin lifecycle

Jazz's plugin runtime is a ports-and-adapters feature. Core owns the ABI-facing domain contracts,
non-failing, validated hook runner, consent digest, and service tags. Adapters own manifest parsing,
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

Saved current and rollback manifests pass through the install-time manifest validator on every
state read. Omitted optional capabilities become empty collections before consent calculation;
malformed manifests or IDs that disagree with the state entry fail closed with a plugin-state
error. Reading does not rewrite the file or change trust, consent, or enablement. Existing consent
grants must still match the current disclosure digest; normalization never grants consent.

The module is imported only after the current lock has valid trust, consent, and agent enablement.
Installation and runtime validation share the lifecycle-event vocabulary in
`core/types/plugin.ts`, including approval events such as `permission-request`. A plugin declaring
those events can load alongside its completion and input handlers; unknown or duplicate events
are rejected at both boundaries.

Registration is synchronous and sealed on return. Hook/provider registrations are session-local so
concurrent agents cannot overwrite one another. Session disposal is best effort only: in-process ESM
cannot be unloaded.

## Code integrity

A trust grant names a digest, and the digest covers a directory: the installed source tree
(`plugins/sources/<digest>/`) or the digest-addressed directory holding a packed `plugin.mjs`
(`plugins/artifacts/<digest>/`). `adapters/src/plugins/source-integrity.ts` keeps the imported code
inside that directory. The same checks run at install, in `inspect`/`doctor` (`artifact valid`), and
in `PluginModuleLoader` before every import, so a copy tampered with after trust is refused:

- The source `entry` goes through `parsePluginSourceEntry` (no absolute path, `..`, `.`, or empty
  segment), the recorded import path must equal the entry joined under the digest root, and the
  entry's real path must be a regular file inside that root.
- Extraction, copying (`copySourceTree`, `O_NOFOLLOW` per file), and hashing (`listSourceTree`)
  refuse symlinks and special files instead of skipping them, so the hashed tree is the imported
  tree.
- `scanPluginImportGraph` walks static imports, re-exports, `require` calls, and literal dynamic
  imports with `Bun.Transpiler.scanImports`, resolves each with `Bun.resolveSync` as the runtime
  would, and refuses anything that is not a runtime built-in or a real file inside the directory.
  Package specifiers are refused because `node_modules` is outside the digest; the SDK is
  types-only and must be imported with `import type`. Imports are scanned without unused-import
  trimming, and JavaScript is scanned as JSX, so the scan sees a superset of what the runtime loads.

Install-time bundling was rejected for source installs: `Bun.build` evaluates Bun macros
(`with { type: "macro" }`, including escaped spellings) while bundling and has no switch to turn
them off, so bundling an untrusted tree would run its code before trust. `scanImports` parses
without evaluating. Computed dynamic imports (`import(variable)`) are not statically visible; they
are part of the reviewed source, like any other runtime behavior of trusted code.

GitHub tarballs go through `fetchWithinOrigins` (`bounded-fetch.ts`): HTTPS only, every redirect
hop on `api.github.com` or `codeload.github.com`, one deadline for the whole download, and byte caps
on both the compressed body and the inflated tar stream (`DEFAULT_TARBALL_LIMITS`). Packed manifests
and artifacts use the same helper pinned to the manifest's origin.

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

## Policy dispatch

`classify.command-risk` runs inside the approval path after `execute_command` has produced its
side-effect-free proposal and before Jazz decides whether the active tier covers that call. It is
never dispatched for a tool with a static `read-only`, `low-risk`, or `high-risk` declaration. The
hook receives the bounded command from the proposal's execution arguments, not arbitrary tool
state, conversation history, results, environment variables, or file contents.

The classification is evidence consumed by host policy, not an execution capability. Core validates
the answer against the three `ToolRiskLevel` outcomes before the policy tier sees it. Tool-set
membership, static risk declarations, explicit command allowlists, the selected approval tier, and
the shell denylist remain host-owned controls. A classified command still follows the ordinary
proposal/approval/execute pair and the denylist still runs before execution.

This hook has more authority than an advisory hook: `read-only` or `low-risk` can make an eligible
command auto-approved under the active policy. Its manifest declaration and command-text data class
therefore participate in the consent digest. A changed hook, destination, or data declaration
invalidates consent just like a changed artifact digest.

Absent handlers and abstention, validation, timeout, provider, secret, or budget failures fall back
to Jazz's built-in command classifier. An unresolved fallback is `high-risk`. Batch preflight stores
the validated classification by tool-call id so the per-call path does not make a second provider
request after parking or concurrent approval checks.

## Distribution checks

The author packer uses Bun with package bundling enabled, splitting disabled, and unresolved imports
forbidden. It accepts exactly one JavaScript output and rejects native modules, WASM, emitted assets,
and remaining runtime imports. Tests must load the identical digest-addressed artifact through both
the development runtime and every standalone release target.

Routing component metrics live under `evals/skill-routing/`. The raw-request lexical scorer is a
proxy, not the current Jazz product baseline. Activation requires paired end-to-end A/B evidence for
actual skill loads and task success, plus latency, failure, false-positive, and cost gates on a held
test split.

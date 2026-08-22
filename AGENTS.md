# Working on Jazz

Instructions for AI agents contributing to this codebase. Read
[README.md](README.md) and [docs/](docs/index.md) first for what the product does;
[docs/internals/](docs/internals/index.md) for how the harness works and
[design-decisions.md](docs/internals/design-decisions.md) for why it works that way.

---

## What Jazz is

An agentic automation CLI: users define autonomous agents that carry out real tasks —
reading and writing files, driving git, searching the web, running shell commands, calling
APIs — with an approval gate in front of anything destructive.

The thesis is that **automation should decide, not just execute**. A shell script follows a
fixed path; a Jazz agent reads the situation, picks tools, checks its own work, and reports
what it did. Everything in the codebase serves that difference.

Jazz is pre-1.0 and ships frequently. It is not "done", and pretending otherwise in docs or
commit messages helps nobody.

---

## What already exists

Know these before proposing to build them:

| Area | Reality |
| --- | --- |
| Providers | 18 behind one AI SDK adapter, including local Ollama and llama.cpp |
| Tools | 34 agent-facing, 7 of them approval-gated, plus MCP and declarative custom tools |
| Context | Two-tier token counting with per-model calibration, turn-aware trimming, compaction at 80% |
| Long runs | 80-iteration budget with pressure injection at 70%/90%, meltdown detection, sub-agents with isolated context |
| Surfaces | Terminal TUI, headless `jazz run`, launchd/cron, GitHub Actions, a Telegram bridge |
| Measurement | An eval harness with pass@k, Pass^k reliability, bootstrap CIs, and A/B between harness configs |

There is **no** plugin system, and agents do **not** learn across runs. Don't describe either
as if it exists.

---

## How to approach a change

### Understand before building

Read the code paths you're about to touch, and the tests around them. Check
`docs/internals/` for whether the pattern already exists — several things that look missing
are implemented under a different name.

### Consider more than one design

For anything non-trivial, sketch two or three approaches and pick deliberately. Say in the PR
why you rejected the others; that reasoning is the part reviewers can't reconstruct.

### Work at the frontier, then prove the lift

Jazz exists to find out how much of the gap between a weak model and a strong one is closable
by the harness rather than the model. So novel patterns are welcome — speculative execution,
verification-refinement loops, multi-model consensus, better context strategies — but a claim
about agent quality is worth only as much as its measurement.

The eval harness exists for exactly this: `bun run evals --agent eval-sut --ab eval-sut-variant`
A/Bs the same tasks across two configs and attributes the difference. If you change the
harness, run it. See [evals/README.md](evals/README.md) and
[docs/internals/evals.md](docs/internals/evals.md).

### Prefer clean breaks to compatibility shims

This is a pre-1.0 CLI, not a library with downstream consumers. When you rename or
restructure, update every usage and delete the old path in the same change. **No
`@deprecated` aliases, no back-compat shims, no dead code left behind.**

That licenses breaking changes *within the work you were asked to do*. It is not a licence to
rewrite adjacent subsystems you happen to be passing through — scope creep is still scope
creep, and an unrequested redesign is a review burden rather than a contribution. If you spot
something worth changing outside your scope, say so instead of doing it.

---

## Standards

### Security

Jazz executes real actions on a user's machine, so this is load-bearing rather than
box-ticking. See [SECURITY.md](SECURITY.md) for the model.

- Validate every external input with a Zod schema at the boundary
- Never log credentials, tokens, or secrets — and check what your error messages interpolate
- New tools declare an honest `riskLevel`; anything mutating is gated, no exceptions
- A tool that shells out inherits `execute_command`'s risk, not its own optimism
- Threat-model the untrusted-input surfaces: chat bridges, fetched web content, PR diffs

### Testing

- `bun test` (bun:test, not vitest). Tests live beside the code they cover
- Cover the failure modes, not just the happy path — timeouts, malformed tool arguments, provider errors
- Effect code gets tested with mock Layers; pure functions get tested directly
- A test that cannot fail is worse than no test. Break your own assertion once to confirm it catches the thing
- Security-relevant behavior gets a regression test (see `shell-tools.security.test.ts`)

### Documentation

Match the level of documentation to how non-obvious the thing is.

- **Code comments: default to none.** Add one only when the *why* isn't evident from the code. Never narrate what the next line does
- Document *decisions* rather than mechanics — a reader can see what the code does, not what you rejected
- Public tools, config fields, and CLI flags need reference entries. `docs/reference/tools.md` is verified by a test and will fail if you add a tool without updating it
- Outdated docs are worse than absent ones: if you change behavior, fix the page that described it
- Run `bun run docs:check-links` before you claim the docs are fine

### Performance

- Profile before optimizing; "this feels slow" is a hypothesis, not a finding
- The dominant costs in an agent run are LLM round trips and tool output volume, in that order — optimize those before micro-optimizing TypeScript
- Parallelize independent tool calls; cache what's expensive and stable
- Lazy-load anything that spawns a process. MCP servers connect on first use for this reason

---

## Stack

- **Bun** — runtime, test runner, and bundler
- **TypeScript**, strict mode, 100% of the codebase
- **Effect-TS** — typed errors, tracked effects, `Layer`-based dependency injection
- **Commander.js** — CLI parsing
- **Ink** (React for terminals) — the interactive TUI
- **Vercel AI SDK** — the provider port

Commands: `bun test` · `bun run typecheck` · `bun run lint` · `bun run build` ·
`bun run docs:check-links` · `bun run evals`

---

## Code style

### Functions

- Use function declarations for top-level functions, not arrow consts — better stack traces
- Arrow functions for callbacks, array methods, and inline operations
- No one-letter names or abbreviations. `agentConfiguration`, not `cfg`

### TypeScript

- `interface` over `type` for object shapes
- Discriminated unions for variants; exhaustive switches over them
- Explicit return types on exported functions
- `readonly` on arrays and object fields that shouldn't be mutated
- Never `any` outside tests. `unknown` plus a narrowing check instead

### Effect-TS

- Every side effect returns an `Effect`
- `Effect.gen` for sequential work, `pipe()` for composition, `Effect.all` for parallel
- Errors are `Data.TaggedError` subclasses, so callers can match on the tag
- Dependencies arrive as `Layer`s; a service is an interface in `core/interfaces/` plus a `Context.Tag`
- `Effect.Ref` for mutable state
- To break a dependency cycle, pass a function parameter rather than importing across layers (see how `summarizer.ts` takes a `RecursiveRunner`)

### Architecture boundaries

`core/` imports nothing from `services/` — the rule is enforced, and breaking it is how the
codebase stops being testable. `core/` defines ports, `services/` implements them, `cli/`
wires the Layers. See [code-map.md](docs/internals/code-map.md).

CLI commands are hierarchical (`jazz agent <action>`), one module each, and must work both
interactively and headlessly.

### Errors

- Specific tagged error types, never a bare `Error` for a known failure mode
- Messages state what failed and what the user can do about it
- A tool failure returns a failed result the agent can reason about; it does not throw and kill the run

### Naming

`PascalCase` types and classes · `camelCase` functions and variables · `SCREAMING_SNAKE_CASE`
constants · `kebab-case` CLI commands and filenames. Don't prefix interfaces with `I`.

---

## Git

- **Never push to `main`.** Feature branches only, and `git pull origin main` before branching
- No `Co-Authored-By: Claude` trailers
- Never stash, reset, or discard uncommitted work without asking first
- Nothing under `docs/superpowers/` is ever committed — it's gitignored deliberately

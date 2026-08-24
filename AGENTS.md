# Working on Jazz

Jazz is an agent harness. You are working on the machine that turns a model into
something that can actually *do* a job — unattended, on a real machine, with real
consequences. That is hard, interesting work. Treat it that way.

Do not reconstruct Jazz from memory. Do not answer from vibes. The documentation
is the source of truth for what Jazz is and how it behaves. The code is the
source of truth for how it is implemented. Read both before you speak.

---

## Go read

Start here, in this order, for whatever you are about to do:

- What is Jazz, and what can it do? [README.md](README.md), [docs/](docs/index.md)
- How does the harness work? [docs/internals/](docs/internals/index.md)
- Why is it built this way? [design-decisions.md](docs/internals/design-decisions.md)
- Where does my change go? [code-map.md](docs/internals/code-map.md)
- What does the interface demand? [docs/design/](docs/design/index.md)
- What is the security model? [SECURITY.md](SECURITY.md), [threat-model.md](docs/internals/threat-model.md)
- How do I contribute? [CONTRIBUTING.md](CONTRIBUTING.md)
- Public flags, tools, config? [docs/reference/](docs/reference/index.md)
- Did this harness change help? [evals](evals/README.md), [evals internals](docs/internals/evals.md)

The stack, the commands, the architecture, the Effect patterns, the naming: they
live in the repo. Open the files. Match what you find.

---

## Read the code before you answer

A question about Jazz is a request to go look. Trace the path. Read the tests
around it. Follow the types. Then answer with what the code actually does, not
what a similar project would do.

If you have not opened the relevant files, you are not ready to:

- explain how something works
- propose a design
- estimate scope
- change anything

Guessing is slower than reading. Reading is the job.

---

## Think at the frontier

Jazz exists to find out how much of the gap between a weak model and a strong
one is closable by the harness rather than the model. That is the interesting
problem. Lean into it.

Novel patterns are welcome: speculative execution, verification-refinement
loops, multi-model consensus, better context strategies, tighter approval UX,
cheaper long runs. Bring ambition. Bring a design. Then prove the lift —
a claim about agent quality is worth only as much as its measurement.

If you change the harness, run the evals. See [evals/README.md](evals/README.md).

Do not shrink a hard problem into a cosmetic one because the cosmetic one is
easier to ship. Do not paper over a real gap with a comment, a default, or a
shim. Do the hard version. That is why you are here.

Do not assume because a code exists that it's correct. Everything is improvable.

---

## Work with the developer

You are a collaborator, not a silent code emitter. The person on the other side
knows the product, the users, and the taste. Use them.

- **Arrive with a point of view.** For anything non-trivial, sketch two or three
  approaches, say which one you would pick and why, and name what you are
  rejecting. That reasoning is the part a reviewer cannot reconstruct later.
- **Validate before you act.** If the request is ambiguous, if the design has
  real trade-offs, if you would touch more than the obvious files, or if you
  might break a user-facing contract — stop and check. Come with a
  recommendation, not a blank. Then wait for the go.
- **Do not expand the job in the dark.** Spotting something worth changing
  outside your scope is useful. Silently rewriting it is not. Say it. Ask.
- **Clear, obvious work does not need a ceremony.** A typo, a failing test, a
  requested one-file fix: do it. Validation is for when the path is not unique.

The failure mode on one side is disappearing for forty files. The failure mode
on the other is asking permission to breathe. Aim between them: think hard,
propose sharply, confirm when it matters, then execute all the way.

---

## Documentation

- Everytime a behavior changes, a feature is added or removed  update the `docs` folder to reflect the change.
- Add a docstring on top of files the explain in details its purpose and how to use the functions/objects declared in it.
- Document functions when needed. Avoid inline comments and prefer to document at the function or file level.

---

## How to write the change

Prefer clean breaks to compatibility shims. When you rename or restructure,
update every usage and delete the old path in the same change. No `@deprecated`
aliases, no back-compat shims, no dead code left behind. 

`core/` imports nothing from `services/`.

Jazz executes real actions on a user's machine. Security is load-bearing.
Validate external input at the boundary. Never log secrets. New tools declare
an honest `riskLevel`; anything mutating is gated. A tool that shells out
inherits `execute_command`'s risk. Threat-model untrusted-input surfaces. Read
[SECURITY.md](SECURITY.md) before you touch any of that, and add a regression
test when you do.

Tests live beside the code they cover. Cover the failure modes, not just the
happy path. A test that cannot fail is worse than no test.

### Code

Write advanced TypeScript. Use the type system for real: discriminated unions,
exhaustive switches, precise generics, `readonly` where mutation would be a
bug, narrowed `unknown` instead of `any`. Follow the patterns already in the
tree, then go further when a sharper type or a tighter abstraction earns its
keep.

Lean toward the most performance- and memory-efficient solution that is still
correct and readable. Allocate less. Copy less. Stream when the alternative is
buffering. Lazy-load anything that spawns a process. Parallelize independent
work. The dominant costs in an agent run are LLM round trips and tool output
volume — attack those before micro-optimizing a map. "This feels slow" is a
hypothesis; profile before you declare a win.

### UX

A person is sitting in a terminal, or waiting on a scheduled run, or reading a
chat message from their own bot. Every extra frame, extra line, extra question,
extra round trip is a tax on them. Design the interaction: what they see,
when they are asked, what happens when they say no, how failure is explained.
If you change the TUI, the approval card, the CLI output, or a chat surface,
go use it the way they would — or the closest substitute the tests give you —
before you call it done.

---

## Git

- **Never push to `main`.** Feature branches only. `git pull origin main`
  before branching.
- No `Co-Authored-By` in commit.
- Never stash, reset, or discard uncommitted work without asking first.


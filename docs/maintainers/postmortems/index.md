---
description: "Jazz post-mortems: incident write-ups that record why a bug escaped tests, the root cause, the rule it produced and the gate that now enforces it."
---

# Post-mortems

A post-mortem is a backward-looking record of a failure that reached a real user, a merged PR or a
release. Its subject is why the process let the bug through, not the one-line fix. A design decision
or a rejected alternative belongs in [design decisions](../design-decisions.md) instead.

Write one when a bug is:

- **Subtle**: the mechanism is non-obvious and a careful engineer would re-derive it the hard way.
- **Systemic**: it escaped because of a gap in tests, tooling or conventions, not a one-off typo.
- **Costly to rediscover**: it cost real debugging time and would cost it again.

Copy [the template](./template.md) to `NNNN-short-slug.md`, take the next number, and add a row
below. Every claim must be checkable from git history, code or PR text; leave out a fact you cannot
verify. The page links the rule and the gate it produced, so a reader can find what now prevents a
repeat.

| #                                       | Title                                                    |
| --------------------------------------- | -------------------------------------------------------- |
| [0001](./0001-bun-fetch-300s-cutoff.md) | Bun's 300-second fetch cutoff killed slow model requests |

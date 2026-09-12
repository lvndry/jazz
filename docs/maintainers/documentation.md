---
description: "Write Jazz documentation that is concise, code-backed, runnable, and useful: editorial standards for concepts, references, tutorials, and feature claims."
---

# Documentation quality standard

Jazz documentation should unlock real work. More content is welcome when each page has a distinct reader, question, and maintained source of truth. Length is not the enemy; low information density and false completeness are.

## Start with the reader's outcome

A tutorial title names what the reader will accomplish: “Investigate an attack and approve a Cloudflare WAF rule,” not “Use parked runs.” Explain the user value before the Jazz mechanism.

A concept page answers what something is, when to use it, and which boundary it owns. A configuration or command page optimizes for exact lookup. Maintainer documentation traces implementation and invariants. Do not force every page into the tutorial shape.

## Reality is a requirement

Before documenting behavior:

1. Read the implementation, types, and tests.
2. Run or mechanically validate every command and configuration field possible.
3. Name prerequisites, persistence requirements, credentials, and network assumptions.
4. Explain what happens on refusal, timeout, invalid input, or unavailable infrastructure.
5. Link to the code or authoritative upstream integration.

Never invent an adapter, binary, API, flag, or happy-path response to make an example look complete. If an organization-specific seam is unavoidable, describe its input/output contract plainly instead of giving a fictional command a plausible name.

## Tutorials must earn the space

A Jazz tutorial includes:

- a valuable end state;
- why Jazz materially enables it;
- real prerequisites and maintained integrations;
- complete setup and execution commands;
- the trust and approval boundary;
- an observable expected result;
- realistic limitations and recovery behavior.

A prompt with a title is not a tutorial. Neither is a partial snippet that tells the reader to invent the hard half. Prefer linking to a maintained repository template over reproducing a large file that will drift.

Distinctive tutorials should combine Jazz capabilities—agents, personas, subagents, peers, surfaces, memory, companions, workflows, structured output, and approvals—only when the combination solves a real problem.

## Make claims searchable and specific

Use the terms a developer would search for: “self-hosted AI pull-request reviewer,” “OpenRouter GitHub Actions,” or “human approval for Cloudflare WAF.” State supported providers, surfaces, and constraints in plain text rather than relying on slogans.

Descriptions should identify both the subject and outcome. Headings should stand alone in search results and answer-engine excerpts. Avoid competitor name-dropping in feature documentation; state the capability clearly enough that a reader comparing systems can find the difference themselves.

## Edit for density

Delete throat-clearing, repeated conclusions, fake quotations, obvious transitions, and generic claims such as “powerful,” “seamless,” or “revolutionary.” Keep details that change a decision or prevent a failure.

Use one strong example instead of five shallow ones. Use diagrams only when relationships are harder to understand in prose. Put exhaustive inventories in lookup pages rather than repeating them across concepts and guides.

## Keep documentation from drifting

Before merging documentation changes, run:

```bash
bun run docs:check-links
bun run docs:check-metadata
bun test packages/core/src/agent/tools/register-tools.docs.test.ts \
  packages/runtime/src/cli-docs.test.ts
```

When a public behavior changes, update the relevant user page in the same change. Prefer contract tests for enumerable facts such as commands, tools, risk levels, and defaults.

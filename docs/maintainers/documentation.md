---
description: "Write Jazz documentation that is concise, code-backed, runnable, and useful: editorial standards for concepts, references, tutorials, and feature claims."
---

# Documentation quality standard

Write for people using Jazz. Help them understand a capability, set it up, and use it.
Keep implementation details in the maintainer section.

## Start with the reader's outcome

A tutorial title names what the reader will accomplish: “Investigate an attack and approve a Cloudflare WAF rule,” not “Use parked runs.” Explain the user value before the Jazz mechanism.

A concept page uses the concept's actual name as its title and explains what it is,
when to use it, and how a user can try it. A configuration or command page optimizes for exact lookup. Maintainer documentation traces implementation and invariants. Do not force every page into the tutorial shape.

## Review the first experience

Read public pages individually, including their linked prerequisites. Check that a new user can:

- understand the capability and recognize a task it helps with;
- complete the setup without assuming an agent, workflow, file, or credential already exists;
- run the example and recognize its expected result;
- find controls for inspecting, changing, or stopping the work;
- reach the CLI and command reference from the navigation.

Keep exhaustive syntax in the reference and implementation details in maintainer pages.
Removing filler is only part of the review; repair missing steps and misleading examples too.

## Reality is a requirement

Before documenting behavior:

1. Read the implementation, types, and tests.
2. Run or mechanically validate every command and configuration field possible.
3. Name prerequisites, persistence requirements, credentials, and network assumptions.
4. Explain what happens on refusal, timeout, invalid input, or unavailable infrastructure.
5. Link to the relevant user reference or authoritative integration documentation.
   Link to implementation files when writing for maintainers.

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

Distinctive tutorials should combine Jazz capabilities, agents, personas, subagents, peers, surfaces, memory, companions, workflows, structured output, and approvals, only when the combination solves a real problem.

## Make claims searchable and specific

Use the terms a developer would search for: “self-hosted AI pull-request reviewer,” “OpenRouter GitHub Actions,” or “human approval for Cloudflare WAF.” State supported providers, surfaces, and constraints in plain text rather than relying on slogans.

Descriptions should identify both the subject and outcome. Headings should stand alone in search results and answer-engine excerpts. Avoid competitor name-dropping in feature documentation; state the capability clearly enough that a reader comparing systems can find the difference themselves.

## Edit for density

Delete throat-clearing, repeated conclusions, fake quotations, obvious transitions, and generic claims such as “powerful,” “seamless,” or “revolutionary.” Keep details that change a decision or prevent a failure.

Prefer a short list or table to a diagram. Use a diagram only when it explains a complex
relationship more clearly than either. Check it at the width of the documentation page.

Start with what the feature does and how to use it. Avoid failure-first introductions,
repository anecdotes, and explanations of ordinary shell syntax. Write directly: “the
standard file for project instructions,” rather than “the cross-tool convention.”

Use one complete example rather than several partial ones. Keep exhaustive inventories
in reference pages.

## Keep documentation from drifting

Before merging documentation changes, run:

```bash
bun run docs:check-links
bun run docs:check-metadata
bun test packages/core/src/agent/tools/register-tools.docs.test.ts \
  packages/runtime/src/cli-docs.test.ts
```

When a public behavior changes, update the relevant user page in the same change. Prefer contract tests for enumerable facts such as commands, tools, risk levels, and defaults.

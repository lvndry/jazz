---
name: prompt-writer
description: Write or revise system prompts, personas, and workflow prompts using evidence-based structure. Use when creating an agent persona, editing personas/*.md, writing a WORKFLOW.md prompt, or when a prompt "isn't being followed" by a model.
---

# Prompt Writer

Write prompts that small models actually follow. This skill encodes the findings of a July 2026 research pass over instruction-following literature (IFScale, ManyIFEval, position-effect studies) and the prompt files of Claude Code, Codex CLI, opencode, pi, Gemini CLI, aider, and Crush.

## The three laws

1. **Instruction count is a multiplicative tax.** Compliance decays roughly as p^n with n rules; small models collapse exponentially (nano tiers hit ~16% at high density). Budget 5-8 hard rules. Adding a rule always dilutes the others — a persona whose rules multiply on every review becomes a policy document nobody weights.
2. **Position is a feature.** Attention is U-shaped: the top and the end get followed, the middle is dead. The single most important rule goes in lines 1-3 AND is restated as the final line. Never bury a load-bearing rule mid-document.
3. **Trajectories beat policies.** One worked example of the desired behavior (user asks X → assistant checks Y → answers with real facts) moves small models more than any described rule. Include exactly one, and name the wrong move explicitly.

## Structure (personas)

Follow this order — it is the skeleton all Jazz personas use:

1. Frontmatter: `name`, `description`, `tone`, `style`, optional `tools` (deny list or categories).
2. Identity: one line — "You are {agentName}, ..." with {agentDescription}. No warm-up.
3. `# Critical Rules`: 5-8 numbered imperatives, one directive per number. Rule 1 is always grounding: "this/my/here" mean the actual environment; check before answering; a generic answer to a specific question is a wrong answer.
4. `# Environment`: the placeholder facts plus ONE connecting imperative ("base the answer on these facts plus live checks — never answer generically").
5. `# Example`: one check-first trajectory in plain language (no parenthetical stage directions — small models echo them as text; no [bracket] templates — they get parroted). Use concrete platform-neutral numbers and add a transfer sentence ("the same pattern applies to ...").
6. `# Communication`: 4-6 bullets (outcome first, terminal rendering, quantified conciseness with an exemption when the deliverable IS the answer, no emoji unless the user uses them first, how to ask).
7. Final line: restate rule 1.

Budget: ~50 lines body, well under 1.5k tokens. Format: markdown headers + numbered lists for GPT-family models (XML tags are an Anthropic-specific habit).

## Phrasing rules

- Imperative and positive: state the substitute action, not just the ban ("First run the check, then answer" beats "never guess").
- Quantify style rules ("at most 6 lines of prose") — vague adjectives are ignored.
- Never assert a safety mechanism that is conditional. "Risky actions trigger an approval prompt" is false in headless runs and actively disarms the model; write the interactive and non-interactive cases separately.
- Keep a secrets rule: nothing in a harness reliably stops a model from printing an API key.
- Every environment fact needs a rule that connects it to answers, or it is decoration.

## Jazz-specific contracts

- Placeholders ({agentName} {agentDescription} {currentDate} {osInfo} {hardware} {shell} {homeDirectory} {hostname} {username} {tty}) are substituted with `.replace`, not `.replaceAll`: **each may appear at most once per file**. The contract test in `src/core/agent/persona-contract.test.ts` enforces this.
- A skills block is appended AFTER the persona at runtime — the persona's final line is not the prompt's true end.
- Workflow prompts (WORKFLOW.md) stack ON TOP of a persona at runtime: never repeat rules the persona carries; keep frontmatter and every `__TEMPLATE_VAR__` byte-exact; state the output contract once precisely and restate it as the file's final line.

## Procedure

1. Read the current prompt and the harness code that consumes it (substitution, appended blocks, output parsers) — contracts first, prose second.
2. Identify the 5-8 behaviors that must survive; everything else is a candidate for deletion or relocation to tool descriptions/skills.
3. Draft to the structure above.
4. Red-team the draft: walk a literal-minded weak model through 3-4 concrete scenarios (a grounding question, an advisory question, a headless destructive task, a long tutoring ask). Fix what breaks.
5. Verify contracts: placeholders once each, frontmatter parses, no emoji, template vars intact. Run the contract test.

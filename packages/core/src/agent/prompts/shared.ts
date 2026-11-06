/**
 * Builds the single harness-owned prompt block that follows an agent's persona.
 * Tool-specific behavior belongs in tool descriptions; this block contains only
 * cross-tool runtime rules and the indexes needed to discover capabilities.
 */

import { UNTRUSTED_TOOL_OUTPUT_RULE } from "@/core/utils/untrusted-content";

/**
 * Canonical machine-grounding block, the single source of truth for the facts
 * the builder injects into persona prompts (Date, OS, Hardware, Shell, Home,
 * Hostname, User, TTY). A new field is added in exactly one place; the builder
 * fills the placeholders from live system info.
 */
export const ENVIRONMENT_TEMPLATE =
  "Environment: Date: {currentDate} | OS: {osInfo} | Hardware: {hardware} | Shell: {shell} | Home: {homeDirectory} | Hostname: {hostname} | User: {username} | TTY: {tty}";

/**
 * Added only for models that cannot generate media themselves, and have no companion to
 * delegate it to — `generate_media` is not in their tool set.
 *
 * Without this line the agent answers "I can't generate images" and stops, which is true but a
 * dead end: the user has no way to discover that another of their agents might be able to, or
 * which model to create one with. Two sentences buys them the next step.
 */
const MEDIA_GENERATION_UNAVAILABLE =
  "Your model cannot generate media. If asked, say so and direct the user to `jazz agent list " +
  "--can image` (or `--can audio`/`--can video`). Do not substitute ASCII art or a description unless asked.";

/**
 * The same situation, except `generate_media` is available: the modality wall is crossable.
 *
 * Said explicitly because a model that knows it cannot draw will refuse before it reads its
 * tool list — the refusal is baked in deeper than the tool description reaches.
 */
const MEDIA_GENERATION_DELEGATED =
  "Your model cannot generate media itself; use generate_media instead of refusing. If delegation " +
  "cannot select a model, say so. Do not substitute ASCII art or a description unless asked.";

const SKILLS_INSTRUCTIONS =
  "Load a matching skill with load_skill; use find_skills only when the index is insufficient. " +
  "A loaded skill is the playbook: follow it without asking first or substituting a shorter workflow.";

const COMPLETION_PREAMBLE = `Follow the persona above as a binding behavior and voice contract. Every response must preserve
its identity, tone, style, priorities, and response patterns—not merely answer accurately in a
generic assistant voice. This applies during tool-heavy work and long conversations too.`;

const COMPLETION_RULES: readonly string[] = [
  `Carry the request to a usable finish. Take necessary in-scope steps without asking whether to
do them; involve the user only when their input is genuinely required. Do not dump a URL and stop.`,
  `Do not stay stuck: after a failure, inspect current documentation and try another sound route.
Report a blocker only after exhausting safe alternatives, with what would unblock it.`,
  `When you genuinely cannot perform an action (no tool, guardrail, missing capability), propose a
concrete workaround the user can execute. In the CLI, the user can run shell commands themselves by
typing \`! <command>\` — suggest a ready-to-run command with that prefix rather than just explaining
why you are blocked. One line on why, then the actionable alternative.`,
  `Never guess what a tool can fetch. Answer questions about earlier work from the actual record.`,
  `When the requested work is complete, report the result and stop; do not offer or invent a
larger follow-up job.`,
];

/** Owns the habit of checking memory first; the `view_memory` description owns how to read it. */
const MEMORY_RECALL_RULE = `Check memory before answering or acting. When a request could be shaped by the user's
preferences, opinions, history, relationships, prior decisions, or past work — whether they are
asking a question or starting a task — call view_memory before responding. "Let's write a blog"
needs memory (writing style, tone preferences) just as much as "what's my favorite color" does.
Skip memory only for requests with no personal dimension: factual lookups, technical questions,
time/weather, or tool operations that don't depend on who the user is. Never guess at something
memory might already know. An empty memory is a valid answer; a wrong guess when the fact was
stored is not.`;

/**
 * Owns when to save; the `manage_memory` description and parameters own how: quoting, topic and
 * scope choice, consolidation and what never to store.
 */
const MEMORY_CAPTURE_RULE = `Save personal facts to memory when the user reveals them. When the user states a preference,
opinion, relationship, or personal fact ("my favorite artist is …", "I'm allergic to shellfish",
"I prefer dark mode"), or corrects how you did something ("too formal", "make it shorter"),
persist it with manage_memory in the same turn — don't wait to be asked.
Skip small talk and temporary task state. If unsure whether a fact is durable, don't save it:
every standing entry is injected into every future turn for every agent, and the user can always
ask you to remember something.`;

/** Owns when to propose; the `propose_lesson` description owns what a lesson contains. */
const LESSON_RULE = `Learn from your own mistakes without being asked. When you change course because you got
something wrong — you reverse a recommendation, the user or new evidence shows your approach was
mistaken, or a check you skipped would have caught it — call propose_lesson in the same turn with
the general rule that would have prevented it. The user reviews it before it is saved.`;

const TOOL_SELECTION_INSTRUCTIONS =
  "Use a matching skill and prefer the most specific available tool. Run independent operations " +
  "in parallel when supported; sequence only dependencies. Split work that could run long into " +
  "smaller steps: several small writes or edits rather than one large one, and a narrow, fast " +
  "command rather than a slow broad one. A single step that takes minutes to produce or run can " +
  "time out and is lost whole.";

const TOOL_SEARCH_INSTRUCTIONS = `
Tools listed below are available but not yet in your schema. Before using one, call search_tools
with a short task description to load its schema; then call it normally. Do not call a deferred
name directly or recreate its capability through the shell.
`;

export interface HarnessPromptOptions {
  readonly hasTools: boolean;
  readonly hasShell?: boolean;
  readonly hasSubagents?: boolean;
  readonly hasToolResultRetrieval?: boolean;
  readonly hasMemoryRecall?: boolean;
  readonly hasMemoryWrite?: boolean;
  readonly hasLessons?: boolean;
  readonly skillsIndex?: string;
  readonly deferredToolsIndex?: string;
  readonly media?: "delegated" | "unavailable";
}

/**
 * Every rule that names a tool is rendered only when the run offers that tool, so the prompt never
 * points the model at a tool absent from its schema. Rules are numbered after gating.
 */
function renderOperatingRules(options: HarnessPromptOptions): string {
  const rules = [...COMPLETION_RULES];
  if (options.hasMemoryRecall === true) {
    rules.push(MEMORY_RECALL_RULE);
  }
  if (options.hasMemoryWrite === true) {
    rules.push(MEMORY_CAPTURE_RULE);
  }
  if (options.hasLessons === true) {
    rules.push(LESSON_RULE);
  }
  const numbered = rules.map((rule, index) => `${index + 1}. ${rule}`);
  return `## Operating rules\n\n${COMPLETION_PREAMBLE}\n\n${numbered.join("\n")}`;
}

export interface HarnessPromptParts {
  /** Rules and tool guidance: constant for a given tool set. */
  readonly stable: string;
  /** Skills index, deferred-tool index and media guidance: the index sections change as skills and unlocked tools do. */
  readonly dynamic?: string;
}

/**
 * Render the harness block in two parts that join, with a blank line, into exactly the
 * block `renderHarnessPrompt` returns.
 */
export function renderHarnessPromptParts(options: HarnessPromptOptions): HarnessPromptParts {
  const stableSections = [renderOperatingRules(options)];

  if (options.hasTools) {
    const guidance = [TOOL_SELECTION_INSTRUCTIONS, UNTRUSTED_TOOL_OUTPUT_RULE];
    if (options.hasShell) {
      guidance.push(
        "Prefer the file tools (read_file, grep, mv, etc.); use execute_command only when they don't cover the task.",
      );
    }
    if (options.hasSubagents) {
      guidance.push("Delegate bulky independent investigation to subagents.");
    }
    if (options.hasToolResultRetrieval) {
      guidance.push(
        "Retrieve offloaded or cut tool results instead of repeating the original call.",
      );
    }
    stableSections.push(`## Tools\n\n${guidance.join(" ")}`);
  }

  const dynamicSections: string[] = [];
  if (options.skillsIndex !== undefined) {
    dynamicSections.push(
      `## Skills\n\n${SKILLS_INSTRUCTIONS}\n\n<available_skills>\n${options.skillsIndex}\n</available_skills>`,
    );
  }
  if (options.deferredToolsIndex !== undefined) {
    dynamicSections.push(
      `## Deferred tools\n\n${TOOL_SEARCH_INSTRUCTIONS.trim()}\n\n<deferred_tools>\n${options.deferredToolsIndex}\n</deferred_tools>`,
    );
  }
  if (options.media !== undefined) {
    const guidance =
      options.media === "delegated" ? MEDIA_GENERATION_DELEGATED : MEDIA_GENERATION_UNAVAILABLE;
    dynamicSections.push(`## Media\n\n${guidance}`);
  }

  return {
    stable: `# Jazz harness\n\n${stableSections.join("\n\n")}`,
    ...(dynamicSections.length > 0 ? { dynamic: dynamicSections.join("\n\n") } : {}),
  };
}

/** Render all Jazz-owned behavioral guidance as one coherent prompt block. */
export function renderHarnessPrompt(options: HarnessPromptOptions): string {
  const { stable, dynamic } = renderHarnessPromptParts(options);
  return dynamic === undefined ? stable : `${stable}\n\n${dynamic}`;
}

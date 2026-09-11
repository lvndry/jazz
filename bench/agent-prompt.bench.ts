// What a turn costs before it reaches the provider.
//
// `buildSystemPrompt` assembles the persona, the tool notes, the skill index,
// the deferred-tool index and every AGENTS.md verbatim — then caches the
// result under an md5 of all of it. So there are two very different numbers:
// the cold assembly, and the warm path that still has to hash every input
// (AGENTS.md contents included) to discover it can reuse the cache. The warm
// row is the one every turn after the first pays.
//
// `buildWorkStatePreamble` is the resume-side companion: it reads the work
// journal off disk and packs the most recent records into a token budget.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { markdownReply, PROSE_PARAGRAPH } from "./corpus";
import { bench, benchAsync, report } from "./harness";
import { agentPromptBuilder, AgentPromptBuilder } from "../packages/core/src/agent/agent-prompt";
import type { AgentPromptOptions } from "../packages/core/src/agent/agent-prompt";
import type { PersonaService } from "../packages/core/src/interfaces/persona-service";
import type { ChatMessage } from "../packages/core/src/types/message";

// Point every ~/.jazz read at a throwaway directory before importing anything
// that resolves a path from it, so a real user's journal can never change
// these numbers (or be read by them).
const jazzHome = mkdtempSync(join(tmpdir(), "jazz-bench-prompt-"));
process.env["JAZZ_HOME"] = jazzHome;
process.on("exit", () => {
  rmSync(jazzHome, { recursive: true, force: true });
});

const { buildWorkStatePreamble } =
  await import("../packages/core/src/agent/context/work-state-preamble");
const { journalPath } = await import("../packages/core/src/agent/context/work-journal");

const ANTHROPIC_HINT = { provider: "anthropic", modelId: "claude-sonnet-4-5" };

const personaService = {
  getPersonaByIdentifier: () =>
    Effect.succeed({
      id: "persona-1",
      name: "coder",
      description: "A careful engineer.",
      systemPrompt: PROSE_PARAGRAPH.repeat(8),
    }),
} as unknown as PersonaService;

const TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "ls",
  "find",
  "grep",
  "execute_command",
  "todo_write",
  "remember",
  "recall",
  "find_skills",
  "search_tools",
  "web_fetch",
  "web_search",
  "retrieve_tool_result",
  "ask_question",
  "spawn_subagent",
] as const;

const options: AgentPromptOptions = {
  agentName: "bench",
  agentDescription: "A benchmark agent.",
  userInput: "Explain what changed in the transcript renderer.",
  toolNames: TOOL_NAMES,
  availableTools: Object.fromEntries(TOOL_NAMES.map((name) => [name, `The ${name} tool.`])),
  knownSkills: Array.from({ length: 24 }, (_unused, index) => ({
    name: `skill-${String(index)}`,
    description: `Use this skill when the task involves subject ${String(index)}.`,
    path: `/skills/skill-${String(index)}/SKILL.md`,
  })),
  deferredTools: Array.from({ length: 30 }, (_unused, index) => ({
    name: `deferred_tool_${String(index)}`,
    summary: `Does deferred thing ${String(index)}.`,
  })),
  // Hashed by content on every call, so their size lands on the warm path too.
  projectInstructions: [
    { path: "/repo/AGENTS.md", content: markdownReply(6_000) },
    { path: "/repo/packages/cli/AGENTS.md", content: markdownReply(2_000) },
  ],
};

function history(messageCount: number): ChatMessage[] {
  return Array.from({ length: messageCount }, (_unused, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `message number ${String(index)}`,
  }));
}

const withHistory: AgentPromptOptions = { ...options, conversationHistory: history(400) };

// Seed a journal: 40 compaction records, more than the 2k-token budget keeps,
// so the packing loop runs and then stops early.
const AGENT_ID = "bench-agent";
const CONVERSATION_ID = "bench-conversation";
const journal = journalPath(AGENT_ID, CONVERSATION_ID);
mkdirSync(dirname(journal), { recursive: true });
writeFileSync(
  journal,
  Array.from({ length: 40 }, (_unused, index) =>
    JSON.stringify({
      recordedAt: new Date(index * 60_000).toISOString(),
      tokensBefore: 120_000,
      tokensAfter: 40_000,
      messagesBefore: 300,
      messagesAfter: 40,
      summary: `### Session ${String(index)}\n\n${PROSE_PARAGRAPH.repeat(4)}`,
    }),
  ).join("\n"),
);

const results = [
  // Cold: a fresh builder per iteration, so the md5 cache is always empty.
  bench(
    "buildSystemPrompt cold (empty cache)",
    () => {
      Effect.runSync(new AgentPromptBuilder().buildSystemPrompt("coder", options, personaService));
    },
    { iterations: 60 },
  ),
  // Warm: the shared builder, hitting the cache — still hashes every input,
  // including both AGENTS.md bodies, to find that out.
  bench("buildSystemPrompt warm (cache hit)", () => {
    Effect.runSync(agentPromptBuilder.buildSystemPrompt("coder", options, personaService));
  }),
  bench("buildAgentMessages warm, 400-message history", () => {
    Effect.runSync(agentPromptBuilder.buildAgentMessages("coder", withHistory, personaService));
  }),
  bench("buildUserPrompt", () => {
    Effect.runSync(agentPromptBuilder.buildUserPrompt("coder", options, personaService));
  }),
  // Resume only: read the journal, pack newest-first into the token budget.
  // Async because the journal read is a real file read — the disk is part of
  // what resume pays, so it stays inside the timed region.
  await benchAsync(
    "buildWorkStatePreamble, 40 journal records",
    async () => {
      await Effect.runPromise(
        buildWorkStatePreamble(AGENT_ID, CONVERSATION_ID, { modelHint: ANTHROPIC_HINT }),
      );
    },
    { iterations: 60 },
  ),
  // The common case: nothing was ever compacted, so the read misses and
  // resume behaves as it did before the journal existed.
  await benchAsync("buildWorkStatePreamble, no journal", async () => {
    await Effect.runPromise(
      buildWorkStatePreamble("absent", "absent", { modelHint: ANTHROPIC_HINT }),
    );
  }),
];

report("agent-prompt", results);

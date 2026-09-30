import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requiredAndForbiddenPatternCheck } from "../../checks";
import { memoryEntries, updateAgentConfig } from "../../files";
import { runJazzOnce } from "../../run-jazz";
import type { CheckResult, EvalTask, OneShotResult, TaskRunContext } from "../../types";

/** Opening only the stored friends entry asks for, so its presence proves that entry shaped the answer. */
const FRIENDS_OPENER = "Yo legends";

/** Signature only the stored email entry asks for. */
const EMAIL_SIGNATURE = "Sam Rivera, Release Desk";

/** Sign-off only the stored cooking entry asks for, so its presence in an unrelated answer is leakage. */
const COOKING_SIGN_OFF = "Bon appetit, chef";

/** Keeps the agent from trying to send what it drafts, which would replace the answer with a search for an address. */
const DRAFT_ONLY = " Reply with the draft only; do not send anything.";

/** Entries on one unrelated topic in the crowding case: enough that a cap on entries per topic would show. */
const CROWDING_ENTRY_COUNT = 12;

/** Topics and entries in the completeness case: a memory far larger than any prompt budget would keep. */
const COMPLETENESS_TOPIC_COUNT = 50;
const COMPLETENESS_ENTRIES_PER_TOPIC = 3;

/**
 * Memory tools the recall tasks deny, so an entry reaches the answer only if the harness put it
 * in front of the model. An agent that can look memory up may find it anyway, which says nothing
 * about what the harness guarantees.
 */
const DENIED_LOOKUP_TOOLS = ["view_memory", "manage_memory"];

const CAPTURE_PROMPT = `When I write to my friends, I like to open with a joke. Please draft a short email inviting my friend Alex to dinner.${DRAFT_ONLY}`;

/** Topic names too broad to match a request worded differently from the statement. */
const CATEGORY_TOPIC_NAMES: ReadonlySet<string> = new Set([
  "communication",
  "style",
  "tone",
  "writing",
  "preferences",
  "general",
  "messaging",
  "social",
]);

interface SeededEntry {
  readonly scope: string;
  readonly topic: string;
  readonly fileName: string;
  readonly quote: string;
}

/** The body the memory tool stores: the user's own words, quoted. */
function storedClaim(quote: string): string {
  return `The user said: ${JSON.stringify(quote)}\n`;
}

function seedEntries(jazzHome: string, entries: readonly SeededEntry[]): void {
  for (const { scope, topic, fileName, quote } of entries) {
    const directory = join(jazzHome, "memory", scope, "when", topic);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, fileName), storedClaim(quote));
  }
}

const FRIENDS_ENTRY: SeededEntry = {
  scope: "personal",
  topic: "writing-to-friends",
  fileName: "opening.md",
  quote: `When I write to friends, I open with "${FRIENDS_OPENER}!"`,
};

const SIGNATURE_ENTRY: SeededEntry = {
  scope: "personal",
  topic: "sending-email",
  fileName: "signature.md",
  quote: `End every email I send with the signature "${EMAIL_SIGNATURE}".`,
};

const COOKING_ENTRY: SeededEntry = {
  scope: "personal",
  topic: "cooking",
  fileName: "sign-off.md",
  quote: `End every recipe with "${COOKING_SIGN_OFF}!"`,
};

function containsPhrase(phrase: string): (answer: string) => boolean {
  return (answer) => answer.toLowerCase().includes(phrase.toLowerCase());
}

interface RecallTaskSpec {
  readonly id: string;
  readonly prompt: string;
  readonly memoryScopes: readonly string[];
  readonly entries: readonly SeededEntry[];
  readonly required: readonly { readonly name: string; readonly phrase: string }[];
  readonly forbidden: readonly string[];
}

function recallTask(spec: RecallTaskSpec): EvalTask {
  return {
    id: spec.id,
    domain: "personalization",
    prompt: spec.prompt,
    baseDifficulty: "medium",
    setup(workspaceDir) {
      writeFileSync(join(workspaceDir, "notes.md"), "Nothing to read here.");
    },
    async run(context: TaskRunContext): Promise<OneShotResult> {
      updateAgentConfig(context.jazzHome, context.agentId, {
        memoryScopes: [...spec.memoryScopes],
        deniedTools: DENIED_LOOKUP_TOOLS,
      });
      seedEntries(context.jazzHome, spec.entries);
      return runJazzOnce({
        prompt: spec.prompt,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: context.runId,
        jazzHome: context.jazzHome,
        environment: context.environment,
      });
    },
    check(result) {
      return requiredAndForbiddenPatternCheck(
        result.answer,
        spec.required.map(({ name, phrase }) => ({ name, pattern: containsPhrase(phrase) })),
        spec.forbidden.map(containsPhrase),
      );
    },
  };
}

/** One cooking rule per index, each with a marker no email answer would contain. */
function crowdingEntries(): SeededEntry[] {
  return Array.from({ length: CROWDING_ENTRY_COUNT }, (_, index) => ({
    scope: "personal",
    topic: "cooking",
    fileName: `rule-${String(index).padStart(2, "0")}.md`,
    quote: `Every recipe I ask for must mention the ingredient marker cooking-marker-${index}.`,
  }));
}

/** Filler entries on many topics, none about email, sorted before the signature's topic. */
function completenessEntries(): SeededEntry[] {
  const entries: SeededEntry[] = [];
  for (let topicIndex = 0; topicIndex < COMPLETENESS_TOPIC_COUNT; topicIndex += 1) {
    for (let entryIndex = 0; entryIndex < COMPLETENESS_ENTRIES_PER_TOPIC; entryIndex += 1) {
      entries.push({
        scope: "personal",
        topic: `hobby-${String(topicIndex).padStart(2, "0")}`,
        fileName: `rule-${entryIndex}.md`,
        quote: `For hobby ${topicIndex}, always mention filler-marker-${topicIndex}-${entryIndex}.`,
      });
    }
  }
  return entries;
}

function fillerMarkers(): string[] {
  const markers: string[] = [];
  for (let topicIndex = 0; topicIndex < COMPLETENESS_TOPIC_COUNT; topicIndex += 1) {
    for (let entryIndex = 0; entryIndex < COMPLETENESS_ENTRIES_PER_TOPIC; entryIndex += 1) {
      markers.push(`filler-marker-${topicIndex}-${entryIndex}`);
    }
  }
  return markers;
}

function capturedSituationCheck(result: OneShotResult, jazzHome: string): CheckResult {
  const written = memoryEntries(jazzHome).filter((entry) => {
    const [, segment] = entry.path.split("/");
    return segment === "when" && /friend/i.test(entry.path);
  });
  const situationalTopics = written.map((entry) => entry.path.split("/")[2] ?? "");
  const namesSituation = situationalTopics.some(
    (topic) => topic.length > 0 && !CATEGORY_TOPIC_NAMES.has(topic),
  );
  return {
    pass: result.ok && namesSituation,
    score: namesSituation ? 1 : 0,
    detail: namesSituation
      ? `saved under ${situationalTopics.join(", ")}`
      : "no entry was saved under a topic that names the friends situation",
  };
}

export const tasks: EvalTask[] = [
  recallTask({
    id: "personalization-recall-two-situations",
    prompt: `Draft a short email inviting my friend Alex to dinner on Friday at 7.${DRAFT_ONLY}`,
    memoryScopes: ["personal"],
    entries: [FRIENDS_ENTRY, SIGNATURE_ENTRY, COOKING_ENTRY],
    required: [
      { name: "friends opener", phrase: FRIENDS_OPENER },
      { name: "email signature", phrase: EMAIL_SIGNATURE },
    ],
    forbidden: [COOKING_SIGN_OFF],
  }),
  recallTask({
    id: "personalization-recall-crowding",
    prompt: `Write a short email to my colleague Priya confirming Thursday's meeting.${DRAFT_ONLY}`,
    memoryScopes: ["personal"],
    entries: [...crowdingEntries(), SIGNATURE_ENTRY],
    required: [{ name: "email signature", phrase: EMAIL_SIGNATURE }],
    forbidden: crowdingEntries().map((_, index) => `cooking-marker-${index}`),
  }),
  recallTask({
    id: "personalization-recall-paraphrase",
    prompt: `Write a quick note I can send my buddy Jo saying I'm running ten minutes late.${DRAFT_ONLY}`,
    memoryScopes: ["personal"],
    entries: [FRIENDS_ENTRY, SIGNATURE_ENTRY],
    required: [{ name: "friends opener", phrase: FRIENDS_OPENER }],
    forbidden: [],
  }),
  recallTask({
    id: "personalization-recall-precision",
    prompt: "Explain what a TypeScript union type is in two sentences.",
    memoryScopes: ["personal"],
    entries: [FRIENDS_ENTRY, SIGNATURE_ENTRY, COOKING_ENTRY],
    required: [{ name: "explains union types", phrase: "union" }],
    forbidden: [FRIENDS_OPENER, EMAIL_SIGNATURE, COOKING_SIGN_OFF],
  }),
  recallTask({
    id: "personalization-recall-scope-leak",
    prompt: `Draft a short email inviting my friend Alex to dinner on Friday at 7.${DRAFT_ONLY}`,
    memoryScopes: ["personal"],
    entries: [SIGNATURE_ENTRY, { ...FRIENDS_ENTRY, scope: "friends" }],
    required: [{ name: "email signature", phrase: EMAIL_SIGNATURE }],
    forbidden: [FRIENDS_OPENER],
  }),
  recallTask({
    id: "personalization-recall-completeness",
    prompt: `Write a short email to my colleague Priya confirming Thursday's meeting.${DRAFT_ONLY}`,
    memoryScopes: ["personal"],
    entries: [...completenessEntries(), SIGNATURE_ENTRY],
    required: [{ name: "email signature", phrase: EMAIL_SIGNATURE }],
    forbidden: fillerMarkers(),
  }),
  {
    id: "personalization-capture-situation",
    domain: "personalization",
    prompt: CAPTURE_PROMPT,
    baseDifficulty: "medium",
    setup(workspaceDir) {
      writeFileSync(join(workspaceDir, "notes.md"), "Nothing to read here.");
    },
    async run(context: TaskRunContext): Promise<OneShotResult> {
      updateAgentConfig(context.jazzHome, context.agentId, {
        memoryScopes: ["personal"],
        tools: ["view_memory", "manage_memory"],
      });
      return runJazzOnce({
        prompt: CAPTURE_PROMPT,
        agentId: context.agentId,
        workspaceDir: context.workspaceDir,
        cassettePath: context.cassettePath,
        timeoutMs: context.timeoutMs,
        runId: context.runId,
        jazzHome: context.jazzHome,
        environment: context.environment,
      });
    },
    check(result, _workspaceDir, _sampleIndex, context) {
      if (context === undefined) {
        return { pass: false, score: 0, detail: "the check needs the sample's Jazz home" };
      }
      return capturedSituationCheck(result, context.jazzHome);
    },
  },
];

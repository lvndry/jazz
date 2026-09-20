/**
 * Offline replay for the Jev compaction redesign: runs the per-call 3-way Choice
 * decision live against Jev over a transcript, applies the asymmetric
 * confidence-gated policy, and reports reduction plus accuracy against labels.
 *
 * Usage:
 *   bun evals/jev-compaction/replay.ts                       # labeled fixture
 *   bun evals/jev-compaction/replay.ts --transcript <path>   # a Message[] JSON file
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PluginSecretStore } from "@jazz/adapters/plugins";

const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0";

// Asymmetric policy: a needed-but-dropped result is a silent loss, so default to
// keeping and only remove on a confident, concentrated signal.
const KEEP_UNLESS_CONFIDENT = 0.55; // below this confidence, never remove anything
const STRONG_DROP = 0.7; // full drop needs at least this much probability mass on "drop"
const TRUNCATE_HEAD_CHARS = 300;
const TRUNCATE_TAIL_CHARS = 150;

type Action = "keep_verbatim" | "truncate" | "drop";

interface ToolUse {
  readonly tool_use_id: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly text?: string;
  readonly isError?: boolean;
  readonly expected?: Action;
}

interface Message {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly toolUses: ToolUse[];
}

interface Transcript {
  readonly goal: string;
  readonly preserveRecentMessages: number;
  readonly messages: Message[];
}

interface Candidate {
  readonly id: string;
  readonly tool: string;
  readonly messageIndex: number;
  readonly resultChars: number;
  readonly isError: boolean;
  readonly expected?: Action;
}

interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

function truncatedLength(chars: number): number {
  if (chars <= TRUNCATE_HEAD_CHARS + TRUNCATE_TAIL_CHARS + 80) return chars;
  return TRUNCATE_HEAD_CHARS + TRUNCATE_TAIL_CHARS + 80;
}

function toolUseChars(toolUse: ToolUse): number {
  const total = JSON.stringify(toolUse.input).length + (toolUse.text?.length ?? 0);
  return total;
}

function transcriptChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const toolUse of message.toolUses) total += toolUseChars(toolUse);
  }
  return total;
}

/** Pin the first message and the newest `preserveRecentMessages`; the rest are candidates. */
function collectCandidates(transcript: Transcript): Candidate[] {
  const { messages, preserveRecentMessages } = transcript;
  const pinnedFrom = messages.length - preserveRecentMessages;
  const candidates: Candidate[] = [];
  messages.forEach((message, messageIndex) => {
    const pinned = messageIndex === 0 || messageIndex >= pinnedFrom;
    if (pinned) return;
    for (const toolUse of message.toolUses) {
      candidates.push({
        id: toolUse.tool_use_id,
        tool: toolUse.tool,
        messageIndex,
        resultChars: toolUse.text?.length ?? 0,
        isError: toolUse.isError ?? false,
        ...(toolUse.expected === undefined ? {} : { expected: toolUse.expected }),
      });
    }
  });
  return candidates;
}

/** Whole history with tool results omitted (a short note), plus the goal. */
function buildState(transcript: Transcript): object {
  return {
    goal: transcript.goal,
    history: transcript.messages.map((message, index) => ({
      i: index,
      role: message.role,
      text: message.text,
      tool_calls: message.toolUses.map((toolUse) => ({
        id: toolUse.tool_use_id,
        tool: toolUse.tool,
        input: JSON.stringify(toolUse.input).slice(0, 200),
        result: `${toolUse.isError ? "error" : "ok"}, ${toolUse.text?.length ?? 0} chars (omitted)`,
      })),
    })),
  };
}

function choiceQuestion(candidate: Candidate): object {
  return {
    type: "choice",
    instructions: `Decide what to do with tool call ${candidate.id} (${candidate.tool}, ${candidate.resultChars}-char ${candidate.isError ? "error " : ""}result) for continuing toward the goal.`,
    criteria: {
      keep_verbatim:
        "Its full output is still needed verbatim — a path, error, value, or state the assistant will rely on, and re-running would not do.",
      truncate:
        "The call mattered but its full output no longer does; a short head and tail is enough to recall what happened.",
      drop: "Neither the call nor its output matters now; removing it entirely loses nothing.",
    },
  };
}

function decide(candidate: Candidate, answer: ChoiceAnswer | undefined): Action {
  if (answer === undefined) return "keep_verbatim";
  if (answer.confidence < KEEP_UNLESS_CONFIDENT) return "keep_verbatim";
  if (answer.choice === "keep_verbatim") return "keep_verbatim";
  if (answer.choice === "drop" && (answer.probabilities["drop"] ?? 0) >= STRONG_DROP) return "drop";
  return "truncate";
}

async function askJev(
  state: object,
  questions: Record<string, object>,
): Promise<Record<string, ChoiceAnswer>> {
  const secrets = new PluginSecretStore();
  const apiKey = await secrets.get("com.jazz.plugins.jev", {
    name: "apiKey",
    env: "TYPESAFE_API_KEY",
    required: true,
    description: "",
  });
  if (!apiKey) throw new Error("No TypeSafe key resolved from env or keyring.");
  const response = await fetch(JEV_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ state, model: JEV_MODEL, questions }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const json = (await response.json()) as {
    answers: Record<string, ChoiceAnswer>;
    usage?: unknown;
  };
  return json.answers;
}

/** Chars a message keeps after an action is applied to each of its calls. */
function keptChars(message: Message, actionById: Map<string, Action>): number {
  let total = message.text.length;
  for (const toolUse of message.toolUses) {
    const action = actionById.get(toolUse.tool_use_id) ?? "keep_verbatim";
    if (action === "drop") continue;
    const resultChars =
      action === "truncate"
        ? truncatedLength(toolUse.text?.length ?? 0)
        : (toolUse.text?.length ?? 0);
    total += JSON.stringify(toolUse.input).length + resultChars;
  }
  return total;
}

async function main(): Promise<void> {
  const flagIndex = process.argv.indexOf("--transcript");
  const fixturePath =
    flagIndex >= 0 ? process.argv[flagIndex + 1]! : path.join(import.meta.dir, "fixture.json");
  const transcript = JSON.parse(await fs.readFile(fixturePath, "utf8")) as Transcript;

  const candidates = collectCandidates(transcript);
  const state = buildState(transcript);
  const questions: Record<string, object> = {};
  for (const candidate of candidates) questions[candidate.id] = choiceQuestion(candidate);

  const started = performance.now();
  const answers = candidates.length === 0 ? {} : await askJev(state, questions);
  const latency = performance.now() - started;

  const actionById = new Map<string, Action>();
  const rows = candidates.map((candidate) => {
    const answer = answers[candidate.id];
    const action = decide(candidate, answer);
    actionById.set(candidate.id, action);
    return {
      id: candidate.id,
      tool: candidate.tool,
      choice: answer?.choice ?? "-",
      confidence: answer?.confidence ?? Number.NaN,
      action,
      expected: candidate.expected ?? "-",
      match: candidate.expected === undefined ? "?" : candidate.expected === action ? "ok" : "MISS",
    };
  });

  const charsBefore = transcriptChars(transcript.messages);
  const charsAfter = transcript.messages.reduce(
    (sum, message) => sum + keptChars(message, actionById),
    0,
  );
  const reduction = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;

  console.log(
    `candidates=${candidates.length}  latency=${latency.toFixed(0)}ms  reduction=${(reduction * 100).toFixed(1)}%  (chars ${charsBefore} -> ${charsAfter})\n`,
  );
  console.log("call  tool    choice         conf   action         expected      ");
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(5)} ${row.tool.padEnd(7)} ${row.choice.padEnd(14)} ${Number.isNaN(row.confidence) ? "  -  " : row.confidence.toFixed(2)}   ${row.action.padEnd(14)} ${row.expected.padEnd(10)} ${row.match}`,
    );
  }
  const labeled = rows.filter((row) => row.expected !== "-");
  if (labeled.length > 0) {
    const hits = labeled.filter((row) => row.match === "ok").length;
    const falseDrops = labeled.filter(
      (row) => row.action === "drop" && row.expected !== "drop",
    ).length;
    console.log(
      `\naccuracy=${hits}/${labeled.length}  false-drops=${falseDrops} (dropped something a label said to keep/truncate)`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

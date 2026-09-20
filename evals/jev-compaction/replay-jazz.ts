/**
 * Runs the Jev compaction redesign over a REAL Jazz conversation transcript
 * (`~/.jazz/history/conversations/<id>/<session>.jsonl`), whose messages are flat
 * {role: user|assistant|tool, content: string}. Tool-result messages (role=tool)
 * are the candidates; user/assistant prose is never touched. Reports the real
 * reduction and a keep/truncate/drop breakdown.
 *
 *   bun evals/jev-compaction/replay-jazz.ts <transcript.jsonl> [--preserve 20] [--limit N]
 */
import * as fs from "node:fs/promises";
import { PluginSecretStore } from "@jazz/adapters/plugins";

const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0";
const KEEP_UNLESS_CONFIDENT = 0.55;
const STRONG_DROP = 0.7;
const TRUNCATE_HEAD = 300;
const TRUNCATE_TAIL = 150;
const MAX_CONCURRENCY = 4;
const ASSISTANT_STATE_CHARS = 400;
const WINDOW = 40;
const PREVIEW_HEAD = 320;
const PREVIEW_TAIL = 140;

type Action = "keep_verbatim" | "truncate" | "drop";
interface Msg {
  readonly role: string;
  readonly content: string;
}
interface ChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Record<string, number>;
}

function loadTranscript(raw: string): Msg[] {
  const messages: Msg[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as { type?: string; message?: Msg };
    if (record.type === "message" && record.message) {
      messages.push({ role: record.message.role, content: String(record.message.content ?? "") });
    }
  }
  return messages;
}

/** Head+tail preview so Jev can see what it is judging without paying for the whole result. */
function preview(text: string): string {
  if (text.length <= PREVIEW_HEAD + PREVIEW_TAIL + 60) return text;
  return `${text.slice(0, PREVIEW_HEAD)}\n…[${text.length - PREVIEW_HEAD - PREVIEW_TAIL} chars of the middle omitted]…\n${text.slice(-PREVIEW_TAIL)}`;
}

function truncate(text: string): string {
  if (text.length <= TRUNCATE_HEAD + TRUNCATE_TAIL + 80) return text;
  return `${text.slice(0, TRUNCATE_HEAD)}\n[… ${text.length - TRUNCATE_HEAD - TRUNCATE_TAIL} chars omitted; re-run the tool if needed …]\n${text.slice(-TRUNCATE_TAIL)}`;
}

async function apiKey(): Promise<string> {
  const key = await new PluginSecretStore().get("com.jazz.plugins.jev", {
    name: "apiKey",
    env: "TYPESAFE_API_KEY",
    required: true,
    description: "",
  });
  if (!key) throw new Error("No TypeSafe key resolved from env or keyring.");
  return key;
}

async function askBatch(
  key: string,
  state: object,
  questions: Record<string, object>,
): Promise<Record<string, ChoiceAnswer>> {
  const response = await fetch(JEV_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ state, model: JEV_MODEL, questions }),
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return ((await response.json()) as { answers: Record<string, ChoiceAnswer> }).answers;
}

const BIG_RESULT = 1500;

function decide(answer: ChoiceAnswer | undefined, size: number): Action {
  if (!answer) return "keep_verbatim";
  if (answer.choice === "drop" && (answer.probabilities["drop"] ?? 0) >= STRONG_DROP) return "drop";
  if (answer.choice === "keep_verbatim" && answer.confidence >= KEEP_UNLESS_CONFIDENT) {
    return "keep_verbatim";
  }
  // Neither a confident keep nor a confident drop. A big result kept "just in case" is
  // where the tokens are, so truncate it to head+tail; a small one is cheap to keep whole.
  if (size > BIG_RESULT) return "truncate";
  if (answer.confidence < KEEP_UNLESS_CONFIDENT) return "keep_verbatim";
  return "truncate";
}

async function main(): Promise<void> {
  const [file] = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  if (!file) throw new Error("Pass a transcript .jsonl path.");
  const preserve = Number(process.argv[process.argv.indexOf("--preserve") + 1]) || 20;
  const limitFlag = process.argv.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number(process.argv[limitFlag + 1]) : Infinity;

  const messages = loadTranscript(await fs.readFile(file, "utf8"));
  const pinnedFrom = messages.length - preserve;
  const candidateIndices = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role === "tool" && index > 0 && index < pinnedFrom)
    .map(({ index }) => index)
    .slice(0, limit);

  const goalText = messages.find((message) => message.role === "user")?.content.slice(0, 500) ?? "";
  const questionFor = (index: number): object => ({
    type: "choice",
    instructions: `Message ${index} is a tool result (${messages[index]!.content.length} chars). Decide what to do with it for continuing the conversation.`,
    criteria: {
      keep_verbatim:
        "Its full contents are still needed verbatim — data, a path, an error, or a value the assistant keeps relying on and could not reconstruct.",
      truncate:
        "It mattered but the full body no longer does; the head and tail shown are enough to recall what happened.",
      drop: "Stale or superseded — a later message already used, replaced, or moved past it, so removing it loses nothing needed now.",
    },
  });

  // Score in bounded windows: each window's state is just that slice (tool results
  // omitted) plus the goal, so state size never depends on transcript length.
  const answers = new Map<number, ChoiceAnswer>();
  const key = await apiKey();
  const started = performance.now();
  const tasks: (() => Promise<void>)[] = [];
  for (let start = 0; start < messages.length; start += WINDOW) {
    const end = Math.min(messages.length, start + WINDOW);
    const windowCandidates = candidateIndices.filter((index) => index >= start && index < end);
    if (windowCandidates.length === 0) continue;
    const state = {
      goal: goalText,
      window: messages.slice(start, end).map((message, offset) => ({
        i: start + offset,
        role: message.role,
        text:
          message.role === "tool"
            ? `[tool result, ${message.content.length} chars] ${preview(message.content)}`
            : message.content.slice(0, ASSISTANT_STATE_CHARS),
      })),
    };
    tasks.push(async () => {
      const questions: Record<string, object> = {};
      for (const index of windowCandidates) questions[`m${index}`] = questionFor(index);
      const result = await askBatch(key, state, questions);
      for (const index of windowCandidates) {
        const answer = result[`m${index}`];
        if (answer) answers.set(index, answer);
      }
    });
  }
  for (let offset = 0; offset < tasks.length; offset += MAX_CONCURRENCY) {
    await Promise.all(tasks.slice(offset, offset + MAX_CONCURRENCY).map((task) => task()));
  }
  const requests = tasks.length;
  const latency = performance.now() - started;

  const actionByIndex = new Map<number, Action>();
  for (const index of candidateIndices)
    actionByIndex.set(index, decide(answers.get(index), messages[index]!.content.length));

  const charsBefore = messages.reduce((sum, message) => sum + message.content.length, 0);
  let charsAfter = 0;
  const counts = { keep_verbatim: 0, truncate: 0, drop: 0 };
  messages.forEach((message, index) => {
    const action = actionByIndex.get(index);
    if (action === undefined) {
      charsAfter += message.content.length;
      return;
    }
    counts[action] += 1;
    if (action === "drop") return;
    charsAfter += action === "truncate" ? truncate(message.content).length : message.content.length;
  });

  console.log(
    `messages=${messages.length} (tool candidates=${candidateIndices.length}, pinned recent=${preserve})`,
  );
  console.log(`requests=${requests}  latency=${(latency / 1000).toFixed(1)}s  window=${WINDOW}`);
  console.log(
    `decisions: keep=${counts.keep_verbatim} truncate=${counts.truncate} drop=${counts.drop}`,
  );
  console.log(
    `chars ${charsBefore} -> ${charsAfter}   reduction=${(((charsBefore - charsAfter) / charsBefore) * 100).toFixed(1)}%  (tool bytes were ${((messages.filter((m) => m.role === "tool").reduce((s, m) => s + m.content.length, 0) / charsBefore) * 100).toFixed(0)}% of the transcript)`,
  );

  const dropped = candidateIndices
    .filter((index) => actionByIndex.get(index) === "drop")
    .sort((a, b) => messages[b]!.content.length - messages[a]!.content.length)
    .slice(0, 4);
  const kept = candidateIndices
    .filter((index) => actionByIndex.get(index) === "keep_verbatim")
    .sort((a, b) => messages[b]!.content.length - messages[a]!.content.length)
    .slice(0, 4);
  const show = (index: number): string =>
    `  [m${index} ${messages[index]!.content.length}ch conf=${answers.get(index)?.confidence.toFixed(2)}] ${messages[index]!.content.replace(/\s+/g, " ").slice(0, 90)}`;
  console.log("\nbiggest DROPPED tool results:");
  for (const index of dropped) console.log(show(index));
  console.log("\nbiggest KEPT tool results:");
  for (const index of kept) console.log(show(index));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

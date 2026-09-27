/**
 * @fileoverview Contextual follow-up buttons under an answer, from a second short model call.
 *
 * Every answer on a button surface carries the static follow-ups (go deeper, shorter, …).
 * A bridge that opts in then asks the model for three suggestions specific to the exchange
 * and swaps them in once they arrive. The call is a one-shot `jazz run` against a tool-less
 * clone of the template agent: dropping the tool schemas cuts the prompt from ~11k tokens to
 * a few hundred, so the buttons change within seconds rather than twenty.
 *
 * A suggestion's prompt is too long for a button's payload (Telegram allows 64 bytes), so
 * suggestions are kept in a bounded in-memory store and the button carries a token.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { removeAgentFile, agentPath, readAgentFile, writeAgentFile } from "./agent-file";
import {
  type ChatSandbox,
  listChatSandboxes,
  sandboxCommand,
  sandboxEnv,
  sandboxOwnership,
} from "./chat-sandbox";
import { type JazzEnvelope, parseEnvelope, writeStdinFrame } from "./jazz-run";

export interface Suggestion {
  readonly label: string;
  readonly prompt: string;
}

/** How long the one-shot suggestion run may take before it is killed. */
const SUGGESTION_RUN_KILL_MS = 90_000;
/** Jazz's own timeout for the same run, under the kill timer. */
const SUGGESTION_RUN_TIMEOUT_MS = 60_000;
/** How much of the exchange the suggestion prompt quotes. */
const QUESTION_EXCERPT_CHARS = 500;
const ANSWER_EXCERPT_CHARS = 1_200;
/** How many suggestions a button row gets. */
const SUGGESTION_COUNT = 3;
const LABEL_MAX_CHARS = 40;
const PROMPT_MAX_CHARS = 500;
/** Suggestions kept for tapping; older ones answer "expired". */
const SUGGESTION_STORE_LIMIT = 500;

/** The prefix of a prompt id a suggestion button answers: `suggest:<token>`. */
export const SUGGESTION_PROMPT_PREFIX = "suggest:";

const GO_DEEPER: Suggestion = {
  label: "🔍 Go deeper",
  prompt:
    "Go deeper on your previous answer: add more detail, concrete specifics, and any important nuances or caveats.",
};
const FALLBACKS: readonly Suggestion[] = [
  {
    label: "✂️ Shorter",
    prompt:
      "Give a much shorter version of your previous answer — 2-3 sentences, just the essentials.",
  },
  {
    label: "🧑‍🏫 Explain simpler",
    prompt:
      "Explain your previous answer in simpler terms, as if to someone with no background in the topic — avoid jargon and use plain language.",
  },
  {
    label: "💡 Example",
    prompt: "Give a concrete, real-world example that illustrates your previous answer.",
  },
];

export interface SuggestionStore {
  /** Keep a set of suggestions and return the token their buttons carry. */
  put(items: readonly Suggestion[]): string;
  get(token: string): readonly Suggestion[] | undefined;
}

export function createSuggestionStore(limit: number = SUGGESTION_STORE_LIMIT): SuggestionStore {
  const stored = new Map<string, readonly Suggestion[]>();
  return {
    put(items) {
      const token = randomUUID().slice(0, 8);
      stored.set(token, items);
      while (stored.size > limit) {
        const oldest = stored.keys().next();
        if (oldest.done) break;
        stored.delete(oldest.value);
      }
      return token;
    },
    get: (token) => stored.get(token),
  };
}

/**
 * Pad a model's suggestions to exactly three with "Go deeper" first, from the static set.
 * The fallback is a safety net for a misbehaving model, not the normal path.
 */
export function ensureThreeWithGoDeeper(items: readonly Suggestion[]): Suggestion[] {
  const hasGoDeeper = items.some((item) => /deeper/i.test(item.label));
  let result = hasGoDeeper ? [...items] : [GO_DEEPER, ...items];
  for (const fallback of FALLBACKS) {
    if (result.length >= SUGGESTION_COUNT) break;
    result = [...result, fallback];
  }
  return result.slice(0, SUGGESTION_COUNT);
}

/** Read the model's JSON array of `{label, prompt}` back out of its answer. */
export function parseSuggestions(answer: string): Suggestion[] {
  const match = /\[[\s\S]*\]/.exec(answer);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: Suggestion[] = [];
  for (const entry of parsed) {
    const record = entry as { label?: unknown; prompt?: unknown } | null;
    if (
      typeof record?.label === "string" &&
      typeof record.prompt === "string" &&
      record.label.trim().length > 0 &&
      record.prompt.trim().length > 0
    ) {
      items.push({
        label: record.label.trim().slice(0, LABEL_MAX_CHARS),
        prompt: record.prompt.trim().slice(0, PROMPT_MAX_CHARS),
      });
    }
    if (items.length >= SUGGESTION_COUNT) break;
  }
  return items.length === 0 ? [] : ensureThreeWithGoDeeper(items);
}

export interface SuggestionRunOptions {
  readonly jazzBinary: string;
  /** Where the seed template lives. */
  readonly jazzHome: string;
  readonly baseAgentId: string;
  /** The tool-less helper agent's id, e.g. `tg_suggest`. */
  readonly suggestAgentId: string;
  readonly surfaceName: string;
  readonly sandbox: ChatSandbox;
  readonly question: string;
  readonly answer: string;
}

function ensureSuggestAgent(options: SuggestionRunOptions): void {
  if (existsSync(agentPath(options.sandbox.home, options.suggestAgentId))) return;
  const template = readAgentFile(options.jazzHome, options.baseAgentId);
  template.id = options.suggestAgentId;
  template.name = options.suggestAgentId;
  template.config["tools"] = [];
  template.config.reasoning = "disable";
  writeAgentFile(options.sandbox.home, template, sandboxOwnership(options.sandbox));
}

async function runOnce(options: SuggestionRunOptions, prompt: string): Promise<JazzEnvelope> {
  const child = Bun.spawn(
    sandboxCommand(options.sandbox, [
      options.jazzBinary,
      "run",
      "--no-tui",
      "--json",
      "--input-stdin",
      "--agent",
      options.suggestAgentId,
      "--reasoning",
      "disable",
      "--max-iterations",
      "1",
      "--approval-policy",
      "read-only",
      "--timeout",
      String(SUGGESTION_RUN_TIMEOUT_MS),
    ]),
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: sandboxEnv(options.sandbox, process.env, options.surfaceName),
    },
  );
  await writeStdinFrame(child, { prompt });
  await child.stdin.end();
  const timeout = setTimeout(() => child.kill(), SUGGESTION_RUN_KILL_MS);
  const [stdout] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  return parseEnvelope(stdout) ?? { ok: false, error: "no output" };
}

/** Ask the model for three next steps specific to this exchange. Empty on any failure. */
export async function generateSuggestions(options: SuggestionRunOptions): Promise<Suggestion[]> {
  ensureSuggestAgent(options);
  const prompt =
    `Conversation:\nUser: ${options.question.slice(0, QUESTION_EXCERPT_CHARS)}\n` +
    `Assistant: ${options.answer.slice(0, ANSWER_EXCERPT_CHARS)}\n\n` +
    "Propose EXACTLY 3 useful next actions the user might tap. Reply with ONLY a JSON array — no " +
    "prose, no code fences:\n" +
    '[{"label":"short button text, <=24 chars, may start with an emoji","prompt":"the message to ' +
    'send if tapped, written first-person as the user"}]\n' +
    'Make them specific to THIS exchange. The first entry must always be a "🔍 Go deeper" style ' +
    "option that asks for more detail, specifics, and nuance on the same answer.";
  const envelope = await runOnce(options, prompt);
  return envelope.ok ? parseSuggestions(envelope.answer) : [];
}

/**
 * Drop every cached helper agent, so the next suggestion re-clones it from the current
 * template (a changed default model on redeploy).
 */
export function removeSuggestAgents(dataDir: string, suggestAgentId: string): void {
  for (const home of [dataDir, ...listChatSandboxes(dataDir).map((sandbox) => sandbox.home)]) {
    removeAgentFile(home, suggestAgentId);
  }
}

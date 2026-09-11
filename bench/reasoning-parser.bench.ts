// `TagPairParser` sits on the per-delta path for every local model that emits
// reasoning in-band as `<think>` tags: each text delta from the provider goes
// through `feed()` before the stream processor sees it. It is a
// character-by-character state machine — so unlike the rest of the streaming
// path, its cost scales with characters rather than with deltas, and the
// registry hands out a defensive instance even for models that never emit a
// tag, which makes the plain-passthrough row the one most users pay.
import { bench, report } from "./harness";
import { selectParser } from "../packages/adapters/src/llm/reasoning/registry";
import { TagPairParser } from "../packages/adapters/src/llm/reasoning/tag-pair-parser";

const PLAIN_DELTA = "and then the function returns early, which explains the failure. ";
const THINKING_DELTA = "let me check the call sites first, then decide. ";

/** One reply's worth of deltas, provider-sized (~60 chars each). */
function plainDeltas(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${PLAIN_DELTA}${String(index)} `);
}

/** A reply that opens with a thinking block, then answers. */
function taggedDeltas(count: number): string[] {
  const deltas: string[] = ["<think>"];
  for (let index = 0; index < count; index += 1) {
    deltas.push(
      index === Math.floor(count / 2) ? "</think>" : `${THINKING_DELTA}${String(index)} `,
    );
  }
  return deltas;
}

/**
 * The case the state machine exists for: a tag split across delta boundaries,
 * one character at a time, so every `MAYBE_OPEN` / `MAYBE_CLOSE` transition is
 * exercised and each buffered char re-runs `matchAny`'s `toLowerCase`.
 */
function splitTagDeltas(count: number): string[] {
  const deltas: string[] = "<think>".split("");
  for (let index = 0; index < count; index += 1) {
    deltas.push(`${THINKING_DELTA}${String(index)} `);
  }
  deltas.push(..."</think>".split(""));
  deltas.push(PLAIN_DELTA);
  return deltas;
}

/** Text that keeps entering MAYBE_OPEN and backing out — `<` without a tag. */
const angleBracketDeltas = Array.from(
  { length: 400 },
  (_unused, index) => `if (a < b && c<${String(index)}>) return <>; `,
);

const plain400 = plainDeltas(400);
const tagged400 = taggedDeltas(400);
const split400 = splitTagDeltas(400);

function feedAll(deltas: readonly string[]): void {
  const parser = new TagPairParser();
  for (const delta of deltas) {
    parser.feed(delta);
  }
  parser.flush();
}

const results = [
  // What a cloud-model stream pays for a parser it never needs.
  bench(
    "feed 400 plain deltas (passthrough)",
    () => {
      feedAll(plain400);
    },
    { iterations: 60 },
  ),
  bench(
    "feed 400 deltas inside <think>",
    () => {
      feedAll(tagged400);
    },
    { iterations: 60 },
  ),
  bench(
    "feed 400 deltas, tags split per character",
    () => {
      feedAll(split400);
    },
    { iterations: 60 },
  ),
  bench(
    "feed 400 deltas of bracket-heavy code",
    () => {
      feedAll(angleBracketDeltas);
    },
    { iterations: 60 },
  ),
  // Parser selection runs once per request, not per delta.
  bench("selectParser, thinking capability", () => {
    selectParser({ provider: "ollama", modelId: "qwen3", capabilities: ["thinking"] });
  }),
];

report("reasoning-parser", results);

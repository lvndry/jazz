// One answer streaming at the reveal rate. Every reveal frame re-renders the
// streaming block, so the cost of a frame must not grow with how much of the
// answer has already landed. Reported as a curve across answer sizes: a flat
// curve is the claim, and one small size would prove nothing.
import { markdownReply } from "./corpus";
import { bench, report } from "./harness";
import { transcriptRows } from "../packages/cli/src/ui/fullscreen/Transcript";
import type { Block } from "../packages/cli/src/ui/fullscreen/types";
import { setThemeVariant } from "../packages/cli/src/ui/theme";

const VIEWPORT = { width: 120, height: 40 };
const ANSWER_SIZES = [1_000, 10_000, 50_000];
/** One reveal frame adds a few characters, about half a word. */
const CHARACTERS_PER_FRAME = 3;
const FRAMES = 200;

setThemeVariant("dark");

function framesFor(size: number): Block[][] {
  const answer = markdownReply(size + CHARACTERS_PER_FRAME * FRAMES);
  const frames: Block[][] = [];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    frames.push([
      { id: "question", seq: 0, kind: "user", text: "Summarize the findings." },
      {
        id: `answer-${String(size)}`,
        seq: 1,
        kind: "agent",
        markdown: answer.slice(0, size + frame * CHARACTERS_PER_FRAME),
        streaming: true,
      },
    ]);
  }
  return frames;
}

/**
 * The expensive branch: one unbroken code fence has no blank line outside a
 * fence to settle at, so its whole body is the open tail and every frame
 * re-highlights all of it. Pinned here so the curve shows it rather than
 * hiding it behind prose-shaped answers.
 */
function fenceAnswer(size: number): string {
  const line = 'const value = compute("a line of generated code"); // 60 chars\n';
  return `Here is the file:\n\n\`\`\`ts\n${line.repeat(Math.ceil((size + CHARACTERS_PER_FRAME * FRAMES) / line.length))}`;
}

function frames(answer: string, size: number, id: string): Block[][] {
  const all: Block[][] = [];
  for (let frame = 0; frame < FRAMES; frame += 1) {
    all.push([
      { id: "question", seq: 0, kind: "user", text: "Summarize the findings." },
      {
        id,
        seq: 1,
        kind: "agent",
        markdown: answer.slice(0, size + frame * CHARACTERS_PER_FRAME),
        streaming: true,
      },
    ]);
  }
  return all;
}

function run(label: string, sequence: readonly Block[][]) {
  return bench(
    label,
    (iteration) => {
      transcriptRows(sequence[iteration % sequence.length] ?? [], VIEWPORT);
    },
    { iterations: FRAMES, warmupIterations: 0 },
  );
}

const results = [
  ...ANSWER_SIZES.map((size) =>
    run(`reveal frame, ${String(size / 1000)}k chars of prose`, framesFor(size)),
  ),
  ...ANSWER_SIZES.map((size) =>
    run(
      `reveal frame, ${String(size / 1000)}k chars in one code fence`,
      frames(fenceAnswer(size), size, `fence-${String(size)}`),
    ),
  ),
];

report("streaming-answer", results);

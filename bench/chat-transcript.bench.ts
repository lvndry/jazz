/**
 * Per-delta cost and retained heap of a long interactive chat, through the
 * production store and each renderer's projection of it. Every turn is a user
 * message, a streamed reasoning block, two write receipts carrying full diffs
 * and a streamed answer, then a turn receipt: the shape of a working session.
 * Each delta commits before the next arrives, the way provider chunks land a
 * throttle window apart in the app, and the renderer consumer projects every
 * commit the way its React tree does (fullscreen: document → blocks → layout;
 * classic: the Ink output snapshot). Terminal painting is left out; the
 * ui-pipeline suite covers it.
 *
 * The cost to watch is the delta at the last turn against the first: a
 * transcript-length term shows up as that ratio, not in the absolute numbers.
 * Each renderer runs in its own child so retained heap is measured alone.
 * BENCH_CHAT_TURNS sets the session length (default 300).
 */
import { fullGC, heapStats } from "bun:jsc";
import { z } from "zod";
import { PROSE_PARAGRAPH, unifiedDiffLines } from "./corpus";
import { benchAsync, report, type BenchResult } from "./harness";
import { positiveLimit } from "./ui-pipeline-fixture";
import { createTranscriptLayout } from "../packages/cli/src/ui/fullscreen/transcript-layout";
import { createFullscreenTranscript } from "../packages/cli/src/ui/fullscreen/transcript-projection";
import { getGlyphs } from "../packages/cli/src/ui/glyphs";
import { UIStore } from "../packages/cli/src/ui/store";
import { THEME, getThemeRevision } from "../packages/cli/src/ui/theme";

type ConsumerKind = "fullscreen" | "classic";

const RESPONSE_DELTAS_PER_TURN = 50;
const REASONING_DELTAS_PER_TURN = 20;
const RECEIPTS_PER_TURN = 2;
/** Diff lines per write receipt; a mid-sized edit. */
const RECEIPT_DIFF_LINES = 80;
const VIEWPORT = { width: 120, height: 40 } as const;

const observation = z.object({
  firstTurnResponseDeltaMs: z.number().finite().nonnegative(),
  lastTurnResponseDeltaMs: z.number().finite().nonnegative(),
  firstTurnReasoningDeltaMs: z.number().finite().nonnegative(),
  lastTurnReasoningDeltaMs: z.number().finite().nonnegative(),
  retainedHeapBytes: z.number().finite(),
  documentEntries: z.number().int().nonnegative(),
  turns: z.number().int().positive(),
});
type Observation = z.infer<typeof observation>;

/** Re-project each commit the way the mounted renderer would. */
function attachConsumer(source: UIStore, kind: ConsumerKind): () => void {
  if (kind === "classic") {
    const unsubscribe = source.subscribeOutput(() => {
      source.getOutputSnapshot();
    });
    source.getOutputSnapshot();
    return unsubscribe;
  }
  const transcript = createFullscreenTranscript();
  const layout = createTranscriptLayout();
  return source.subscribePresentation(() => {
    const presentation = source.getPresentationSnapshot();
    const blocks = transcript(presentation, presentation.ephemeral.regions);
    const index = layout.update(blocks, {
      width: VIEWPORT.width,
      glyphs: getGlyphs(),
      themeRevision: getThemeRevision(),
      colors: THEME,
    });
    index.window(Math.max(0, index.length - VIEWPORT.height), VIEWPORT.height);
  });
}

/** Let the store's microtask commit run, as it does between provider chunks. */
async function commit(): Promise<void> {
  await Promise.resolve();
}

function receiptDiff(turn: number, receipt: number): string {
  return unifiedDiffLines(RECEIPT_DIFF_LINES)
    .map((line) => `${line} // turn ${String(turn)} receipt ${String(receipt)}`)
    .join("\n");
}

interface TurnTiming {
  readonly responseDeltaMs: number;
  readonly reasoningDeltaMs: number;
}

async function driveTurn(source: UIStore, turn: number): Promise<TurnTiming> {
  source.printOutput({ type: "user", message: `question ${String(turn)}`, timestamp: new Date() });
  await commit();

  const reasoningId = source.openEphemeral("reasoning", "Reasoning", 6);
  await commit();
  let reasoningText = "";
  let reasoningMs = 0;
  for (let delta = 0; delta < REASONING_DELTAS_PER_TURN; delta += 1) {
    const chunk = `considering option ${String(delta)} for turn ${String(turn)}. `;
    reasoningText += chunk;
    const start = performance.now();
    source.appendEphemeral(reasoningId, chunk);
    await commit();
    reasoningMs += performance.now() - start;
  }
  source.collapseEphemeral(reasoningId, {
    line: "Reasoning",
    fullText: reasoningText,
    durationMs: 1_200,
  });
  await commit();

  for (let receipt = 0; receipt < RECEIPTS_PER_TURN; receipt += 1) {
    const diffText = receiptDiff(turn, receipt);
    source.printOutput({
      type: "info",
      message: {
        kind: "notice",
        tone: "log",
        text: `write src/module-${String(receipt)}.ts`,
        audience: "classic",
      },
      timestamp: new Date(),
    });
    source.printOutput({
      type: "log",
      message: {
        kind: "tool",
        receipt: {
          app: "write_file",
          summary: `wrote src/module-${String(receipt)}.ts`,
          status: "ok",
          args: `src/module-${String(receipt)}.ts`,
          durationMs: 40,
          detail: diffText,
          diffPreview: { lines: diffText.split("\n").slice(0, 8), hiddenLines: 72 },
          diffText,
        },
      },
      timestamp: new Date(),
    });
    await commit();
  }

  let responseMs = 0;
  for (let delta = 0; delta < RESPONSE_DELTAS_PER_TURN; delta += 1) {
    const chunk =
      delta % 10 === 9
        ? `turn ${String(turn)} sentence ${String(delta)} ends.\n\n`
        : PROSE_PARAGRAPH.slice(0, 60).trim() + " ";
    const start = performance.now();
    source.appendStream("response", chunk);
    await commit();
    responseMs += performance.now() - start;
  }
  source.finalizeStream();
  source.settleTurnThought();
  source.printOutput({
    type: "debug",
    message: { kind: "turn-receipt", steps: [{ durationMs: 2_000, totalTokens: 1_500 }] },
    timestamp: new Date(),
  });
  await commit();
  return {
    responseDeltaMs: responseMs / RESPONSE_DELTAS_PER_TURN,
    reasoningDeltaMs: reasoningMs / REASONING_DELTAS_PER_TURN,
  };
}

async function worker(kind: ConsumerKind, turns: number): Promise<Observation> {
  fullGC();
  const before = heapStats().heapSize;
  const source = new UIStore();
  const detach = attachConsumer(source, kind);
  let first: TurnTiming | undefined;
  let last: TurnTiming | undefined;
  for (let turn = 0; turn < turns; turn += 1) {
    const timing = await driveTurn(source, turn);
    if (turn === 0) {
      first = timing;
    }
    last = timing;
  }
  fullGC();
  const retainedHeapBytes = heapStats().heapSize - before;
  const documentEntries = source.getDocumentSnapshot().entries.length;
  detach();
  if (first === undefined || last === undefined) {
    throw new Error("No turns were driven");
  }
  return {
    firstTurnResponseDeltaMs: first.responseDeltaMs,
    lastTurnResponseDeltaMs: last.responseDeltaMs,
    firstTurnReasoningDeltaMs: first.reasoningDeltaMs,
    lastTurnReasoningDeltaMs: last.reasoningDeltaMs,
    retainedHeapBytes,
    documentEntries,
    turns,
  };
}

if (process.argv[2] === "--worker") {
  const kind = process.argv[3];
  if (kind !== "fullscreen" && kind !== "classic") {
    throw new Error("Unknown consumer");
  }
  console.log(JSON.stringify(await worker(kind, Number(process.argv[4]))));
} else {
  const turns = positiveLimit("BENCH_CHAT_TURNS", 300);
  const results: BenchResult[] = [];
  for (const kind of ["fullscreen", "classic"] satisfies ConsumerKind[]) {
    let observed: Observation | undefined;
    const result = await benchAsync(
      `${kind} ${String(turns)} turns, isolated child`,
      async () => {
        const child = Bun.spawn(
          [process.execPath, import.meta.path, "--worker", kind, `${turns}`],
          {
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (code !== 0) {
          throw new Error(`Chat transcript child exited ${String(code)}: ${stderr}`);
        }
        observed = observation.parse(JSON.parse(stdout.trim()));
      },
      { iterations: 1, warmupIterations: 0 },
    );
    if (observed === undefined) {
      throw new Error("No chat transcript observation returned");
    }
    console.error(
      `${kind}: response delta ${observed.firstTurnResponseDeltaMs.toFixed(4)}ms → ${observed.lastTurnResponseDeltaMs.toFixed(4)}ms, reasoning delta ${observed.firstTurnReasoningDeltaMs.toFixed(4)}ms → ${observed.lastTurnReasoningDeltaMs.toFixed(4)}ms, retained heap ${String(observed.retainedHeapBytes)} bytes`,
    );
    results.push({ ...result, metrics: { ...observed } });
  }
  report("chat-transcript", results);
}

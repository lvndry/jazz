/**
 * Per-delta cost and retained memory of a long interactive chat, through the
 * production store and each renderer's projection of it. Every turn is a user
 * message, a streamed reasoning block, two write receipts carrying full diffs
 * and a streamed answer, then a turn receipt: the shape of a working session.
 * Each delta commits before the next arrives, the way provider chunks land a
 * throttle window apart in the app, and the renderer consumer projects every
 * commit the way its React tree does (fullscreen: document → blocks → layout;
 * classic: the Ink output snapshot). Terminal painting is left out; the
 * ui-pipeline suite covers it.
 *
 * The cost to watch is the median delta over the last turns against the first:
 * a transcript-length term shows up as that ratio, not in the absolute numbers.
 * Each renderer runs in its own child so retained memory is measured alone;
 * retained data leaves out compiled code, which varies from run to run.
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
/**
 * Turns driven and cleared before measuring, so compiled code and module caches are already
 * in the baseline heap and the first measured turn runs warm.
 */
const WARMUP_TURNS = 20;
/** Turns timed at each end of the session; medians keep a collection pause from posing as cost. */
const SAMPLED_TURNS = 5;
/**
 * Heap snapshot classes that hold compiled code and object shapes rather than data. JIT tiering
 * moves them by megabytes between runs of the same commit, so the data metric leaves them out.
 */
const CODE_CLASS =
  /CodeBlock|Executable|Module|Structure|SymbolTable|SourceCode|PropertyTable|RareData|GetterSetter/;

const observation = z.object({
  firstTurnResponseDeltaMs: z.number().finite().nonnegative(),
  lastTurnResponseDeltaMs: z.number().finite().nonnegative(),
  firstTurnReasoningDeltaMs: z.number().finite().nonnegative(),
  lastTurnReasoningDeltaMs: z.number().finite().nonnegative(),
  retainedDataBytes: z.number().finite(),
  retainedHeapBytes: z.number().finite(),
  documentEntries: z.number().int().nonnegative(),
  turns: z.number().int().positive(),
});
type Observation = z.infer<typeof observation>;

interface HeapSnapshot {
  readonly nodes: readonly number[];
  readonly nodeClassNames: readonly string[];
}
/** Fields per node in a JSC heap snapshot: id, size, class index, flags. */
const SNAPSHOT_NODE_FIELDS = 4;

/** Live bytes outside compiled code, from a heap snapshot taken after a full collection. */
function liveDataBytes(): number {
  fullGC();
  const snapshot = Bun.generateHeapSnapshot() as unknown as HeapSnapshot;
  let total = 0;
  for (let index = 0; index < snapshot.nodes.length; index += SNAPSHOT_NODE_FIELDS) {
    const className = snapshot.nodeClassNames[snapshot.nodes[index + 2] ?? 0] ?? "";
    if (!CODE_CLASS.test(className)) {
      total += snapshot.nodes[index + 1] ?? 0;
    }
  }
  return total;
}

/** Re-project each commit the way the mounted renderer would. */
function attachConsumer(source: UIStore, kind: ConsumerKind): () => void {
  if (kind === "classic") {
    const unsubscribe = source.subscribeOutput(() => {
      source.getOutputSnapshot();
    });
    source.getOutputSnapshot();
    return unsubscribe;
  }
  let mountedDocument = "";
  let transcript = createFullscreenTranscript();
  let layout = createTranscriptLayout();
  return source.subscribePresentation(() => {
    const presentation = source.getPresentationSnapshot();
    const documentKey = `${presentation.document.id}:${String(presentation.documentGeneration)}`;
    if (documentKey !== mountedDocument) {
      mountedDocument = documentKey;
      layout.dispose();
      transcript = createFullscreenTranscript();
      layout = createTranscriptLayout();
    }
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

interface DeltaSamples {
  readonly response: number[];
  readonly reasoning: number[];
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function driveTurn(source: UIStore, turn: number, samples?: DeltaSamples): Promise<void> {
  source.printOutput({ type: "user", message: `question ${String(turn)}`, timestamp: new Date() });
  await commit();

  const reasoningId = source.openEphemeral("reasoning", "Reasoning", 6);
  await commit();
  let reasoningText = "";
  for (let delta = 0; delta < REASONING_DELTAS_PER_TURN; delta += 1) {
    const chunk = `considering option ${String(delta)} for turn ${String(turn)}. `;
    reasoningText += chunk;
    const start = performance.now();
    source.appendEphemeral(reasoningId, chunk);
    await commit();
    samples?.reasoning.push(performance.now() - start);
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

  for (let delta = 0; delta < RESPONSE_DELTAS_PER_TURN; delta += 1) {
    const chunk =
      delta % 10 === 9
        ? `turn ${String(turn)} sentence ${String(delta)} ends.\n\n`
        : PROSE_PARAGRAPH.slice(0, 60).trim() + " ";
    const start = performance.now();
    source.appendStream("response", chunk);
    await commit();
    samples?.response.push(performance.now() - start);
  }
  source.finalizeStream();
  source.settleTurnThought();
  source.printOutput({
    type: "debug",
    message: { kind: "turn-receipt", steps: [{ durationMs: 2_000, totalTokens: 1_500 }] },
    timestamp: new Date(),
  });
  await commit();
}

async function worker(kind: ConsumerKind, turns: number): Promise<Observation> {
  const source = new UIStore();
  const detach = attachConsumer(source, kind);
  for (let turn = 0; turn < WARMUP_TURNS; turn += 1) {
    await driveTurn(source, turn);
  }
  source.clearOutputs();
  await commit();
  const dataBefore = liveDataBytes();
  fullGC();
  const before = heapStats().heapSize;
  const first: DeltaSamples = { response: [], reasoning: [] };
  const last: DeltaSamples = { response: [], reasoning: [] };
  for (let turn = 0; turn < turns; turn += 1) {
    const samples = turn < SAMPLED_TURNS ? first : turn >= turns - SAMPLED_TURNS ? last : undefined;
    await driveTurn(source, turn, samples);
  }
  fullGC();
  const retainedHeapBytes = heapStats().heapSize - before;
  const retainedDataBytes = liveDataBytes() - dataBefore;
  const documentEntries = source.getDocumentSnapshot().entries.length;
  detach();
  return {
    firstTurnResponseDeltaMs: median(first.response),
    lastTurnResponseDeltaMs: median(last.response),
    firstTurnReasoningDeltaMs: median(first.reasoning),
    lastTurnReasoningDeltaMs: median(last.reasoning),
    retainedDataBytes,
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
      `${kind}: response delta ${observed.firstTurnResponseDeltaMs.toFixed(4)}ms → ${observed.lastTurnResponseDeltaMs.toFixed(4)}ms, reasoning delta ${observed.firstTurnReasoningDeltaMs.toFixed(4)}ms → ${observed.lastTurnReasoningDeltaMs.toFixed(4)}ms, retained data ${String(observed.retainedDataBytes)} bytes, retained heap with compiled code ${String(observed.retainedHeapBytes)} bytes`,
    );
    results.push({ ...result, metrics: { ...observed } });
  }
  report("chat-transcript", results);
}

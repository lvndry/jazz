/** Proves the incremental fullscreen projection matches projecting the whole document. */
import { describe, expect, it } from "bun:test";
import { createFullscreenTranscript, transcriptBlocks } from "./transcript-projection";
import type { Block } from "./types";
import { outputFromEntry, projectDocumentEntries } from "../document";
import { UIStore, type PresentationSnapshot } from "../store";

/** Every block of the document, projected from scratch the way the bridge used to. */
function wholeDocumentBlocks(presentation: PresentationSnapshot): readonly Block[] {
  return transcriptBlocks({
    outputs: projectDocumentEntries(presentation.document, {
      streamReveal: presentation.streamReveal,
    }).map(outputFromEntry),
    streaming: "",
    regions: presentation.ephemeral.regions,
    expandedReasoningIds: presentation.expandedReasoningIds,
    expandedReceiptIds: presentation.expandedReceiptIds,
    liveReasoningIds: presentation.liveReasoningIds,
    ...(presentation.document.streamingId === undefined
      ? {}
      : { streamingId: presentation.document.streamingId }),
  });
}

/** Block numbering only has to stay stable between frames, so it is left out of the comparison. */
function withoutSeq(blocks: readonly Block[]): unknown[] {
  return blocks.map(({ seq: _seq, ...rest }) => rest);
}

async function commit(): Promise<void> {
  await Promise.resolve();
}

describe("incremental fullscreen transcript", () => {
  it("projects every commit of a long session the same as the whole document", async () => {
    const store = new UIStore();
    const project = createFullscreenTranscript();
    let previous: readonly Block[] = [];
    let commits = 0;
    store.subscribePresentation(() => {
      const presentation = store.getPresentationSnapshot();
      const blocks = project(presentation, presentation.ephemeral.regions);
      expect(withoutSeq(blocks)).toEqual(withoutSeq(wholeDocumentBlocks(presentation)));
      for (const block of blocks) {
        const before = previous.find((candidate) => candidate.id === block.id);
        if (before !== undefined && Bun.deepEquals(before, block)) {
          expect(block).toBe(before);
        }
      }
      previous = blocks;
      commits++;
    });
    for (let turn = 0; turn < 12; turn++) {
      store.printOutput({ type: "user", message: `question ${turn}`, timestamp: new Date(0) });
      await commit();
      for (let step = 0; step < 2; step++) {
        const reasoning = store.openEphemeral("reasoning", "Reasoning", 4);
        await commit();
        store.appendEphemeral(reasoning, `thinking ${turn}.${step} `);
        await commit();
        store.appendEphemeral(reasoning, "more");
        await commit();
        store.collapseEphemeral(reasoning, { durationMs: 500 });
        await commit();
        store.printOutput({
          type: "log",
          message: {
            kind: "tool",
            receipt: {
              app: turn % 2 === 0 ? "manage_todos" : "write_file",
              summary: `step ${step}`,
              status: "ok",
              args: `file-${turn}.ts`,
              diffText: `+ line ${turn}`,
            },
          },
          timestamp: new Date(0),
        });
        await commit();
      }
      for (const word of ["streamed ", "answer ", `for ${turn}\n\n`, "tail"]) {
        store.appendStream("response", word);
        await commit();
      }
      store.finalizeStream();
      store.settleTurnThought();
      await commit();
      if (turn % 4 === 3) {
        store.toggleLastReceiptDiff();
        await commit();
        store.expandLastReasoning("in-place");
        await commit();
      }
    }
    expect(commits).toBeGreaterThan(100);
  });
});

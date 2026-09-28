import type { Block, ReasoningBlock } from "./types";

/**
 * One folded reasoning line per turn. A turn that thinks before each of three
 * tool calls produces three collapsed reasoning blocks, and each used to take
 * its own row between the receipts. They now fold into the first one, which
 * carries their combined duration and how many steps it stands for. A block the
 * reader has opened with ctrl+r stays where it is, at full length.
 *
 * A turn runs from one user message to the next.
 */
export function foldTurnReasoning(blocks: readonly Block[]): Block[] {
  const folded: Block[] = [];
  let turnHead: { index: number; block: ReasoningBlock } | undefined;
  for (const block of blocks) {
    if (block.kind === "user") {
      turnHead = undefined;
      folded.push(block);
      continue;
    }
    if (block.kind !== "reasoning" || !block.collapsed) {
      folded.push(block);
      continue;
    }
    if (turnHead === undefined) {
      const head: ReasoningBlock = { ...block, steps: block.steps ?? 1 };
      turnHead = { index: folded.length, block: head };
      folded.push(head);
      continue;
    }
    const previous = turnHead.block;
    const durationMs =
      previous.durationMs === undefined && block.durationMs === undefined
        ? undefined
        : (previous.durationMs ?? 0) + (block.durationMs ?? 0);
    const merged: ReasoningBlock = {
      ...previous,
      steps: (previous.steps ?? 1) + (block.steps ?? 1),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
    turnHead = { index: turnHead.index, block: merged };
    folded[turnHead.index] = merged;
  }
  return folded;
}

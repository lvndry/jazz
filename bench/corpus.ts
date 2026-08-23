// Deterministic inputs shared across benches. No randomness: two runs of the
// same commit must do identical work so numbers are comparable.
import type { Block } from "../src/cli/ui/fullscreen/types";
import type { OutputEntry } from "../src/cli/ui/types";

export const PROSE_PARAGRAPH =
  "The quick brown fox jumps over the lazy dog while `code spans` and **bold runs** " +
  "force the markdown pipeline to lex, wrap, and highlight every line it touches.\n\n";

export const MARKDOWN_WITH_STRUCTURE = [
  "## Findings",
  "",
  PROSE_PARAGRAPH.trim(),
  "",
  "| module | mean ms | p95 ms |",
  "|---|---|---|",
  "| transcript | 0.45 | 0.55 |",
  "| markdown | 1.20 | 1.90 |",
  "",
  "- first item with `inline code` and a [link](https://example.com)",
  "- second item that wraps because it keeps going past the column budget",
  "",
  "```ts",
  "export function reduceEvent(accumulator: Accumulator, event: StreamEvent): Accumulator {",
  '  if (event.type === "text_chunk") return { ...accumulator, text: accumulator.text + event.delta };',
  "  return accumulator;",
  "}",
  "```",
  "",
].join("\n");

export function markdownReply(approximateBytes: number): string {
  let reply = "";
  while (reply.length < approximateBytes) {
    reply += MARKDOWN_WITH_STRUCTURE;
  }
  return reply;
}

export function codeFenceLines(lineCount: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(
      `const value${String(index)} = compute(${String(index)}); // trailing note "with strings"`,
    );
  }
  return lines;
}

export function unifiedDiffLines(lineCount: number): string[] {
  const lines: string[] = ["--- a/src/module.ts", "+++ b/src/module.ts", "@@ -1,20 +1,20 @@"];
  for (let index = 0; index < lineCount; index += 1) {
    const marker = index % 3 === 0 ? "+" : index % 3 === 1 ? "-" : " ";
    lines.push(`${marker}  const value${String(index)} = compute(${String(index)});`);
  }
  return lines;
}

export function settledBlocks(conversationTurns: number): Block[] {
  const blocks: Block[] = [];
  for (let index = 0; index < conversationTurns; index += 1) {
    const seq = index * 3;
    blocks.push({ id: `u${String(index)}`, seq, kind: "user", text: `question ${String(index)}?` });
    blocks.push({
      id: `t${String(index)}`,
      seq: seq + 1,
      kind: "tool",
      app: "files",
      summary: `read src/module-${String(index)}.ts`,
      status: "ok",
    });
    blocks.push({
      id: `a${String(index)}`,
      seq: seq + 2,
      kind: "agent",
      markdown: PROSE_PARAGRAPH.repeat(3),
    });
  }
  return blocks;
}

export function outputEntries(entryCount: number): OutputEntry[] {
  const entries: OutputEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    entries.push({
      id: `entry-${String(index)}`,
      type: "streamContent",
      message: index % 3 === 2 ? PROSE_PARAGRAPH.repeat(3) : `line ${String(index)} of output`,
      timestamp: new Date(0),
      ...(index % 3 === 1 ? { meta: { kind: "toolResult" } } : {}),
    });
  }
  return entries;
}

export function streamDeltas(deltaCount: number): string[] {
  const deltas: string[] = [];
  for (let index = 0; index < deltaCount; index += 1) {
    deltas.push(index % 40 === 39 ? "sentence ends here.\n\n" : `token${String(index)} `);
  }
  return deltas;
}

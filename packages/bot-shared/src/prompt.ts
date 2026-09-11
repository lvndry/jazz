/**
 * @fileoverview Asking the operator a question, when there is one to ask.
 *
 * Written against stdin directly rather than Bun's `prompt`, which returns null
 * on a closed stream in a way that is indistinguishable from an empty answer.
 */

/** Read one line from stdin. Resolves empty when the stream ends first. */
export async function promptLine(question: string): Promise<string> {
  process.stderr.write(`${question} `);
  for await (const chunk of process.stdin) {
    return new TextDecoder().decode(chunk as Uint8Array).trim();
  }
  return "";
}

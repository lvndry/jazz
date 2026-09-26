/**
 * @fileoverview Choosing a new loop's name: the one the user gave, or the start of its prompt,
 * made a valid handle and unique among this installation's loops.
 */

import { Effect } from "effect";
import { LoopStoreTag } from "@/core/interfaces/loop-store";
import { handleFrom, uniqueHandle } from "@/core/utils/handle";
import { getJazzInstanceId } from "@/core/utils/instance-id";

/** The name of a loop whose name and prompt have nothing usable. */
const FALLBACK_LOOP_NAME = "loop";

/** Words of the prompt a loop is named after when the user gave no name. */
const PROMPT_NAME_WORDS = 3;

/** Words that carry no meaning in a name, skipped when naming a loop after its prompt. */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "the",
  "then",
  "to",
  "whether",
]);

/** The start of `prompt` as a name: its first meaningful words. */
export function nameFromPrompt(prompt: string): string {
  return prompt
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word))
    .slice(0, PROMPT_NAME_WORDS)
    .join(" ");
}

export function chooseLoopName(options: { readonly name?: string; readonly prompt: string }) {
  return Effect.gen(function* () {
    const store = yield* LoopStoreTag;
    const taken = new Set(
      (yield* store.list({ ownerInstanceId: getJazzInstanceId() })).map((loop) => loop.name),
    );
    const suggested = options.name ?? nameFromPrompt(options.prompt);
    return uniqueHandle(handleFrom(suggested, FALLBACK_LOOP_NAME), taken);
  });
}

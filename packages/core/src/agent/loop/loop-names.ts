/**
 * @fileoverview Choosing a new loop's name: the one the user gave, or the start of its prompt,
 * made a valid handle and unique among this installation's loops.
 */

import { Effect } from "effect";
import { LoopStoreTag } from "@/core/interfaces/loop-store";
import { handleFrom, leadingWords, uniqueHandle } from "@/core/utils/handle";
import { getJazzInstanceId } from "@/core/utils/instance-id";

/** The name of a loop whose name and prompt have nothing usable. */
const FALLBACK_LOOP_NAME = "loop";

/** Words of the prompt a loop is named after when the user gave no name. */
const PROMPT_NAME_WORDS = 3;

export function chooseLoopName(options: { readonly name?: string; readonly prompt: string }) {
  return Effect.gen(function* () {
    const store = yield* LoopStoreTag;
    const taken = new Set(
      (yield* store.list({ ownerInstanceId: getJazzInstanceId() })).map((loop) => loop.name),
    );
    const suggested = options.name ?? leadingWords(options.prompt, PROMPT_NAME_WORDS);
    return uniqueHandle(handleFrom(suggested, FALLBACK_LOOP_NAME), taken);
  });
}

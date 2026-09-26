/**
 * @fileoverview Choosing a new goal's name: the one the agent suggested, made a valid handle and
 * unique among this installation's goals.
 */

import { Effect } from "effect";
import { GoalStoreTag } from "@/core/interfaces/goal-store";
import { handleFrom, uniqueHandle } from "@/core/utils/handle";
import { getJazzInstanceId } from "@/core/utils/instance-id";

/** The name of a goal whose suggested name has nothing usable. */
const FALLBACK_GOAL_NAME = "goal";

export function chooseGoalName(suggested: string | undefined) {
  return Effect.gen(function* () {
    const store = yield* GoalStoreTag;
    const taken = new Set(
      (yield* store.list({ ownerInstanceId: getJazzInstanceId() }))
        .map((goal) => goal.name)
        .filter((name): name is string => name !== undefined),
    );
    return uniqueHandle(handleFrom(suggested, FALLBACK_GOAL_NAME), taken);
  });
}

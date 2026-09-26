/**
 * @fileoverview Choosing a new goal's name: the one the agent suggested, made a valid handle and
 * unique among this installation's goals.
 */

import { Effect } from "effect";
import { GoalStoreTag } from "@/core/interfaces/goal-store";
import { getGoalOwnerInstanceId } from "./goal-owner";
import { goalNameFrom, uniqueGoalName } from "./goal-record";

export function chooseGoalName(suggested: string | undefined) {
  return Effect.gen(function* () {
    const store = yield* GoalStoreTag;
    const taken = new Set(
      (yield* store.list({ ownerInstanceId: getGoalOwnerInstanceId() }))
        .map((goal) => goal.name)
        .filter((name): name is string => name !== undefined),
    );
    return uniqueGoalName(goalNameFrom(suggested), taken);
  });
}

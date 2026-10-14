import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import {
  INITIAL_CHOICE_REMOVAL,
  pendingRemovalHints,
  reduceChoiceRemoval,
  removalError,
  runRemoval,
  withoutRemoved,
} from "./choice-removal";
import { createPickerState, reducePicker } from "./picker-core";

const choices = [
  { label: "First", value: "first" },
  { label: "Second", value: "second" },
];

describe("choice removal", () => {
  it("asks, then deletes on start and leaves the row out", () => {
    const asked = reduceChoiceRemoval(INITIAL_CHOICE_REMOVAL, {
      kind: "ask",
      value: "second",
      label: "Second",
    });
    expect(pendingRemovalHints(asked)?.map((hint) => hint.key)).toEqual(["enter", "esc"]);

    const removing = reduceChoiceRemoval(asked, { kind: "start" });
    expect(removing.status.phase).toBe("removing");
    expect(reduceChoiceRemoval(removing, { kind: "keep" })).toBe(removing);

    const removed = reduceChoiceRemoval(removing, { kind: "removed", value: "second" });
    expect(removed.status.phase).toBe("idle");
    expect(withoutRemoved(choices, removed).map((choice) => choice.value)).toEqual(["first"]);
  });

  it("keeps the row on esc and reports a refused deletion", async () => {
    const asked = reduceChoiceRemoval(INITIAL_CHOICE_REMOVAL, {
      kind: "ask",
      value: "first",
      label: "First",
    });
    expect(reduceChoiceRemoval(asked, { kind: "keep" }).status.phase).toBe("idle");

    const outcome = await runRemoval(() => Effect.fail(new Error("It is in use.")), "first");
    const failed = reduceChoiceRemoval(reduceChoiceRemoval(asked, { kind: "start" }), outcome);
    expect(removalError(failed)).toBe("It is in use.");
    expect(withoutRemoved(choices, failed)).toBe(choices);
  });

  it("turns a defect in the deletion into a refusal", async () => {
    const outcome = await runRemoval(() => Effect.die(new Error("disk gone")), "first");
    expect(outcome).toEqual({ kind: "failed", message: "disk gone" });
  });

  it("keeps the picker cursor on a row after the last one is removed", () => {
    const picker = reducePicker(createPickerState({ type: "search", choices }), {
      kind: "move",
      delta: 1,
    });
    expect(picker.cursor).toBe(1);
    const shorter = reducePicker(picker, { kind: "setChoices", choices: [choices[0]!] });
    expect(shorter.cursor).toBe(0);
  });
});

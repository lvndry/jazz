/**
 * @fileoverview Adapter between the store's `Choice<T>` and the core's
 * `PickerChoice`.
 *
 * The core is intentionally value-agnostic (values are strings); the store
 * carries `value: T`. These helpers convert on the way in and resolve the
 * original `T` on the way out, so components keep their typed `onSelect`.
 */

import type { Choice } from "../types";
import { alignTabColumns } from "./description-columns";
import type { PickerChoice } from "./picker-core";

export function toPickerChoices<T>(choices: readonly Choice<T>[]): readonly PickerChoice[] {
  const descriptions = alignTabColumns(choices.map((choice) => choice.description));
  return choices.map((choice, index) => {
    const description = descriptions[index];
    return {
      label: choice.label,
      value: String(choice.value),
      ...(description === undefined ? {} : { description }),
      ...(choice.disabled === true ? { disabled: true } : {}),
      ...(choice.tag === undefined ? {} : { tag: choice.tag }),
      ...(choice.tagTone === undefined ? {} : { tagTone: choice.tagTone }),
    };
  });
}

/**
 * Where a single-answer picker's cursor starts: on the enabled choice whose value is the
 * prompt's default, else on the first enabled choice. Both renderers start from here.
 */
export function initialChoiceIndex<T>(
  choices: readonly Choice<T>[],
  defaultValue: unknown,
): number {
  if (defaultValue !== undefined) {
    const index = choices.findIndex(
      (choice) => Object.is(choice.value, defaultValue) && choice.disabled !== true,
    );
    if (index >= 0) {
      return index;
    }
  }
  const firstEnabled = choices.findIndex((choice) => choice.disabled !== true);
  return firstEnabled < 0 ? 0 : firstEnabled;
}

export function originalValueFromPicker<T>(
  choices: readonly Choice<T>[],
  pickerValue: string,
): T | undefined {
  const match = choices.find((choice) => String(choice.value) === pickerValue);
  return match?.value;
}

export function originalValuesFromPicker<T>(
  choices: readonly Choice<T>[],
  pickerValues: readonly string[],
): T[] {
  return pickerValues
    .map((value) => originalValueFromPicker(choices, value))
    .filter((value): value is T => value !== undefined);
}

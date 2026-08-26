/**
 * @fileoverview Adapter between the store's `Choice<T>` and the core's
 * `PickerChoice`.
 *
 * The core is intentionally value-agnostic (values are strings); the store
 * carries `value: T`. These helpers convert on the way in and resolve the
 * original `T` on the way out, so components keep their typed `onSelect`.
 */

import type { Choice } from "../types";
import type { PickerChoice } from "./picker-core";

export function toPickerChoices<T>(choices: readonly Choice<T>[]): readonly PickerChoice[] {
  return choices.map((choice) => ({
    label: choice.label,
    value: String(choice.value),
    ...(choice.description === undefined ? {} : { description: choice.description }),
    ...(choice.disabled === true ? { disabled: true } : {}),
  }));
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

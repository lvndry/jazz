/**
 * @fileoverview React hook binding the pure picker core to component state.
 *
 * Ink (standard) components share this hook so their *state, transitions and
 * derived view* all come from `picker-core` — the only place left to them is
 * translating ink key events into `PickerIntent`s and painting the view. The
 * fullscreen renderer drives the same pure functions from its external
 * controls, so both hosts agree on behaviour by construction.
 */

import { useCallback, useMemo, useState } from "react";
import {
  createPickerState,
  derivePickerView,
  reducePicker,
  resolvePicker,
  type PickerChoice,
  type PickerIntent,
  type PickerResolution,
  type PickerState,
  type PickerType,
  type PickerView,
} from "./picker-core";

export interface UsePickerOptions {
  readonly type: PickerType;
  readonly choices: readonly PickerChoice[];
  readonly allowMultiple?: boolean;
  readonly allowCustom?: boolean;
  readonly defaultChecked?: readonly number[];
  readonly initialCursor?: number;
  /** Called when the user confirms; receives the resolved value(s). */
  readonly onResolve: (resolution: PickerResolution) => void;
  /** Called when the user cancels (escape). */
  readonly onCancel?: (() => void) | undefined;
}

export interface UsePicker {
  readonly state: PickerState;
  readonly view: PickerView;
  readonly dispatch: (intent: PickerIntent) => void;
  readonly resolve: () => PickerResolution;
  readonly setCustomValue: (value: string) => void;
}

export function usePicker(options: UsePickerOptions): UsePicker {
  const [state, setState] = useState<PickerState>(() =>
    createPickerState({
      type: options.type,
      choices: options.choices,
      allowMultiple: options.allowMultiple ?? false,
      allowCustom: options.allowCustom ?? false,
      defaultChecked: options.defaultChecked ?? [],
      initialCursor: options.initialCursor ?? 0,
    }),
  );

  const dispatch = useCallback(
    (intent: PickerIntent) => {
      if (intent.kind === "submit") {
        const resolution = resolvePicker(state);
        // A non-resolvable row (e.g. cursor on a disabled choice) is ignored,
        // not cancelled — escape is the only cancel path.
        if (resolution.kind !== "none") {
          options.onResolve(resolution);
        }
        return;
      }
      setState((previous) => reducePicker(previous, intent));
    },
    [state, options],
  );

  const setCustomValue = useCallback((value: string) => {
    setState((previous) => ({ ...previous, customValue: value }));
  }, []);

  const view = useMemo(() => derivePickerView(state), [state]);

  const resolve = useCallback(() => resolvePicker(state), [state]);

  return { state, view, dispatch, resolve, setCustomValue };
}

import { store } from "./store";
import { listThemes, revertPreview } from "./theme";
import type { PromptState } from "./types";

/**
 * Open the fullscreen theme picker and wait for a choice.
 *
 * Moving the highlight previews each theme across the whole frame. Resolves the chosen
 * `name:variant`, or undefined when the picker is dismissed, in which case the preview is
 * reverted to the committed theme. Committing and saving the choice is the caller's job.
 */
export function pickThemeInteractively(): Promise<string | undefined> {
  const rows = listThemes().map((listing) => ({
    id: listing.id,
    name: listing.name,
    label: listing.label,
    variant: listing.variant,
    swatches: listing.swatches,
    current: listing.current,
  }));
  // Opened from the idle chat, the picker covers the chat prompt and hands it back on close.
  const underneath = store.getPromptSnapshot();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (chosen: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (store.getPromptSnapshot() === picker) {
        store.setPrompt(underneath);
      }
      if (chosen === undefined) {
        revertPreview();
      }
      resolve(chosen);
    };
    const picker: PromptState = {
      type: "theme",
      message: "Theme",
      options: { themes: rows },
      resolve: (value: unknown) => settle(typeof value === "string" ? value : undefined),
      reject: () => settle(undefined),
    };
    store.setPrompt(picker);
  });
}

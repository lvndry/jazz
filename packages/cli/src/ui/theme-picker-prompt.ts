import { store } from "./store";
import { listThemes, revertPreview } from "./theme";

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
  return new Promise((resolve) => {
    store.setPrompt({
      type: "theme",
      message: "Theme",
      options: { themes: rows },
      resolve: (value: unknown) => {
        store.setPrompt(null);
        resolve(typeof value === "string" ? value : undefined);
      },
      reject: () => {
        store.setPrompt(null);
        revertPreview();
        resolve(undefined);
      },
    });
  });
}

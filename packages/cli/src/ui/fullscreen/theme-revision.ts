import { useSyncExternalStore } from "react";
import { getThemeRevision, onThemeChange } from "../theme";

/**
 * The theme's revision, re-rendering the caller whenever the palette changes.
 *
 * Colours are read from `THEME` at render time, so a component that re-renders after a switch
 * paints the new palette. A memoised component whose props did not change would not re-render,
 * and would leave the old palette on screen until something else touched it — which is what a
 * live `/theme` switch looked like: some rows in the new colours, the rest in the old. Every
 * memoised region calls this, and passes the revision into any memo of painted output.
 */
export function useThemeRevision(): number {
  return useSyncExternalStore(onThemeChange, getThemeRevision);
}

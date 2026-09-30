/**
 * Pane-state registry: the only pane-product code the chat service sees.
 *
 * The chat session calls `attachPaneStateReporting()` when it starts and
 * `detachPaneStateReporting()` when it ends. The registry discovers which
 * pane products (Herdr, and TUIOS or similar later) are present, wires
 * them to the session snapshot, and releases every pane on process exit.
 *
 * Adding a pane product: create its adapter file here and append it to
 * `DEFAULT_ADAPTERS` — nothing outside this directory changes.
 */

import { herdrPaneAdapter } from "@/cli/integrations/herdr";
import {
  installPaneStateExitHooks,
  type PaneStateAdapter,
  type PaneStateSnapshot,
} from "@/cli/integrations/pane-state";

/** The store surface the registry needs, so it never imports the store. */
export interface PaneStateStore {
  getSessionSnapshot(): PaneStateSnapshot;
  subscribeSession(listener: () => void): () => void;
}

const DEFAULT_ADAPTERS: readonly PaneStateAdapter[] = [herdrPaneAdapter()];

let adapters: readonly PaneStateAdapter[] = DEFAULT_ADAPTERS;
let unsubscribe: (() => void) | undefined;

/**
 * Wires every active pane adapter to the session snapshot. Idempotent;
 * safe to call when no pane product is present (then it does nothing).
 * A snapshot that throws is ignored — reporting must never disturb the chat.
 * `adapterOverride` exists for tests; production callers omit it.
 */
export function attachPaneStateReporting(
  store: PaneStateStore,
  adapterOverride?: readonly PaneStateAdapter[],
): void {
  if (unsubscribe !== undefined) return;
  adapters = adapterOverride ?? DEFAULT_ADAPTERS;
  const active = adapters.filter((adapter) => adapter.isActive);
  if (active.length === 0) return;
  installPaneStateExitHooks(() => releaseAll());
  unsubscribe = store.subscribeSession(() => {
    const snapshot = store.getSessionSnapshot();
    for (const adapter of active) {
      try {
        adapter.onSnapshot(snapshot);
      } catch {
        // Fail-open.
      }
    }
  });
}

/** Stops mirroring the session; idempotent. Pane release happens on exit. */
export function detachPaneStateReporting(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}

function releaseAll(): void {
  for (const adapter of adapters) {
    try {
      adapter.release();
    } catch {
      // Fail-open.
    }
  }
}

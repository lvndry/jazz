import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PaneStateAdapter, PaneStateSnapshot } from "@/cli/integrations/pane-state";
import {
  attachPaneStateReporting,
  detachPaneStateReporting,
  type PaneStateStore,
} from "@/cli/integrations/pane-state-registry";

/**
 * The registry is tested through a fake store and a fake always-active
 * adapter, and with Herdr's env explicitly cleared, so the test is
 * deterministic regardless of test order or environment.
 */

function snapshot(): PaneStateSnapshot {
  return {
    activity: { phase: "idle" } as PaneStateSnapshot["activity"],
    approvalRequest: null,
    activeMenu: null,
    currentConversation: null,
  };
}

class FakeStore implements PaneStateStore {
  listeners = 0;

  getSessionSnapshot(): PaneStateSnapshot {
    return snapshot();
  }

  subscribeSession(listener: () => void): () => void {
    this.listeners += 1;
    return () => {
      this.listeners -= 1;
      listener();
    };
  }
}

function fakeAdapter(): PaneStateAdapter {
  return {
    isActive: true,
    name: "fake",
    onSnapshot: () => {},
    release: () => {},
  };
}

describe("pane-state registry", () => {
  let savedHerdrEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedHerdrEnv = { ...process.env };
    delete process.env["HERDR_ENV"];
  });

  afterEach(() => {
    process.env = savedHerdrEnv;
    detachPaneStateReporting();
  });

  test("attach is idempotent: a second attach does not stack listeners", () => {
    const store = new FakeStore();
    attachPaneStateReporting(store, [fakeAdapter()]);
    attachPaneStateReporting(store, [fakeAdapter()]);
    expect(store.listeners).toBe(1);
  });

  test("detach stops the subscription and is repeatable", () => {
    const store = new FakeStore();
    attachPaneStateReporting(store, [fakeAdapter()]);
    detachPaneStateReporting();
    expect(store.listeners).toBe(0);
    detachPaneStateReporting();
  });

  test("attach is a full no-op when no adapter is active (no tiling workspace)", () => {
    const store = new FakeStore();
    attachPaneStateReporting(store, [{ ...fakeAdapter(), isActive: false }]);
    expect(store.listeners).toBe(0);
  });

  test("detach before attach never throws", () => {
    expect(() => detachPaneStateReporting()).not.toThrow();
  });
});

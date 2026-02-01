/**
 * Pure logic for syncing text input refs from React state.
 * Extracted so we can unit test ordering behavior without React.
 *
 * When the conversation is long, re-renders (logs, stream) often run before
 * our setState commits; syncing refs from props then would revert our
 * optimistic update and reorder text. This function decides when to overwrite
 * refs (synced / external) vs when to keep them (stale).
 */

export interface RefSyncState {
  valueRef: string;
  cursorRef: number;
  lastSentValue: string | null;
  lastSentCursor: number | null;
  previousValue: string;
  previousCursor: number;
}

export interface RefSyncInput {
  /** Current value from React state (props) */
  value: string;
  /** Current cursor from React state (props) */
  cursor: number;
  /** Ref state from previous run */
  state: RefSyncState;
}

export interface RefSyncResult {
  /** New ref values to use for display and next key handling */
  valueRef: string;
  cursorRef: number;
  /** New pending/sync state */
  lastSentValue: string | null;
  lastSentCursor: number | null;
  previousValue: string;
  previousCursor: number;
}

/**
 * Compute new ref and pending state from current props and previous state.
 * - No pending (lastSentValue === null): sync refs from props.
 * - Pending and state caught up (value === lastSentValue): sync and clear pending.
 * - Pending and state stale (value === previousValue): keep refs so next key uses optimistic value.
 * - Pending and external (value differs from both): sync and clear pending.
 */
export function computeTextInputRefSync(input: RefSyncInput): RefSyncResult {
  const { value, cursor, state } = input;
  const {
    valueRef: currentValueRef,
    cursorRef: currentCursorRef,
    lastSentValue,
    lastSentCursor,
    previousValue,
    previousCursor,
  } = state;

  if (lastSentValue !== null) {
    if (value === lastSentValue && cursor === lastSentCursor) {
      return {
        valueRef: value,
        cursorRef: cursor,
        lastSentValue: null,
        lastSentCursor: null,
        previousValue: value,
        previousCursor: cursor,
      };
    }
    if (value === previousValue && cursor === previousCursor) {
      return {
        valueRef: currentValueRef,
        cursorRef: currentCursorRef,
        lastSentValue,
        lastSentCursor,
        previousValue,
        previousCursor,
      };
    }
    return {
      valueRef: value,
      cursorRef: cursor,
      lastSentValue: null,
      lastSentCursor: null,
      previousValue: value,
      previousCursor: cursor,
    };
  }

  return {
    valueRef: value,
    cursorRef: cursor,
    lastSentValue: null,
    lastSentCursor: null,
    previousValue: value,
    previousCursor: cursor,
  };
}

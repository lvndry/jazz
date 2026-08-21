/** @jsxImportSource @opentui/react */
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import React, { useCallback, useRef, useState } from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { Input } from "./Input";
import { hintsFor, resolveEscape, resolveFocusKey, type KeyAction } from "./keymap";
import { LiveZone } from "./LiveZone";
import { Approval } from "./overlays/Approval";
import { Search } from "./overlays/Search";
import { Transcript } from "./Transcript";
import { MIN_HEIGHT, MIN_WIDTH, type Focus, type ViewModel } from "./types";

/**
 * The shell: five stacked regions and a floating overlay layer.
 *
 * Everything here is layout and intent-routing. The regions are pure functions
 * of the view model, so a frame is reproducible from data alone — which is why
 * the layout can be asserted character by character in tests rather than
 * eyeballed.
 *
 * The ordering matters and is the design: the input and footer are anchored to
 * the bottom, the live zone sits directly above them, and the transcript takes
 * whatever is left. So when work starts, the live zone grows *upward* and the
 * conversation yields the rows — the thing under the user's hands never moves.
 */

export interface AppProps {
  readonly view: ViewModel;
  readonly onAction: (action: KeyAction) => void;
  /**
   * First refusal on every key. Return true to consume it.
   *
   * There is exactly one keyboard registration in this tree on purpose: two
   * independent `useKeyboard` hooks leave it ambiguous which one sees a key,
   * and the loser silently receives nothing.
   */
  readonly onKey?: (key: { name: string; ctrl: boolean }) => boolean;
}

/**
 * Below the minimum there is no honest frame to draw, so draw none.
 *
 * A partial frame is worse than a message: box edges land in the wrong places
 * and the reader cannot tell a layout bug from a small window. This says the
 * size it needs, the size it has, and the way out.
 */
function TooSmall({ width, height }: { width: number; height: number }): React.ReactNode {
  return (
    <box style={{ width, height, flexDirection: "column" }}>
      <text style={{ fg: THEME.selected }}>{`jazz needs ${MIN_WIDTH}x${MIN_HEIGHT}`}</text>
      <text style={{ fg: THEME.muted }}>{`this terminal is ${width}x${height}`}</text>
      <text style={{ fg: THEME.muted }}>resize, or run with --plain</text>
    </box>
  );
}

export function App({ view, onAction, onKey }: AppProps): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const [focus, setFocus] = useState<Focus>("input");
  const armedAt = useRef<number | undefined>(undefined);
  const glyphs = getGlyphs();

  const overlayOpen = view.overlay !== undefined;

  const dispatch = useCallback(
    (action: KeyAction) => {
      switch (action.type) {
        case "focus-input":
          setFocus("input");
          break;
        case "focus-transcript":
          setFocus("transcript");
          break;
        case "arm-interrupt":
          armedAt.current = Date.now();
          break;
        case "interrupt":
          armedAt.current = undefined;
          break;
        default:
          break;
      }
      onAction(action);
    },
    [onAction],
  );

  useKeyboard((key) => {
    const name = typeof key === "string" ? key : (key.name ?? "");
    const ctrl = typeof key === "string" ? false : key.ctrl === true;

    // The caller gets the key first, so the composer and the overlays see
    // typing before focus and Esc handling do.
    if (onKey?.({ name, ctrl }) === true) return;

    if (name === "escape") {
      dispatch(
        resolveEscape(
          {
            overlayOpen,
            searchActive: view.overlay?.kind === "search",
            completionOpen: false,
            runActive: view.live.tools.length > 0 || view.live.waiting !== undefined,
            ...(armedAt.current === undefined ? {} : { interruptArmedAt: armedAt.current }),
            inputEmpty: view.input.value.length === 0,
            focus,
          },
          Date.now(),
        ),
      );
      return;
    }

    // An overlay owns the keyboard while it is open; the regions behind it must
    // not act on keys the user is aiming at the card.
    if (overlayOpen) return;

    const focusAction = resolveFocusKey(name, focus);
    if (focusAction.type !== "noop") dispatch(focusAction);
  });

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return (
      <TooSmall
        width={width}
        height={height}
      />
    );
  }

  const viewport = { width, height };
  const footer = { ...view.footer, hints: hintsFor(focus, view.live.tools.length > 0) };

  return (
    <box style={{ width, height, flexDirection: "column" }}>
      <Header
        model={view.header}
        viewport={viewport}
      />

      {/* One hairline under the header. The regions do not draw their own. */}
      <box style={{ height: 1, flexShrink: 0 }}>
        <text style={{ fg: THEME.border }}>{glyphs.divider.repeat(width)}</text>
      </box>

      <Transcript
        blocks={view.blocks}
        viewport={viewport}
        focus={focus}
        {...(view.newBelow === undefined ? {} : { newBelow: view.newBelow })}
      />

      <LiveZone
        model={view.live}
        viewport={viewport}
      />
      <Input
        model={{ ...view.input, disabled: view.input.disabled || overlayOpen }}
        viewport={viewport}
      />
      <Footer
        model={footer}
        viewport={viewport}
      />

      {view.overlay?.kind === "approval" ? (
        <Approval
          model={view.overlay}
          viewport={viewport}
        />
      ) : null}
      {view.overlay?.kind === "search" ? (
        <Search
          model={view.overlay}
          viewport={viewport}
        />
      ) : null}
    </box>
  );
}

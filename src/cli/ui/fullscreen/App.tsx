/** @jsxImportSource @opentui/react */
import {
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getGlyphs } from "../glyphs";
import { THEME } from "../theme";
import {
  copyText,
  pasteTextFromEvent,
  selectedTextFromRenderer,
  textFromSelection,
} from "./clipboard";
import { selectedText as selectedComposerText } from "./composer-edit";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { Input } from "./Input";
import {
  consumeKeyEvent,
  hintsFor,
  isCopyChord,
  isCtrlLetter,
  isInterruptChord,
  isPrintableSequence,
  normalizeKey,
  resolveEscape,
  resolveFocusKey,
  resolveScrollKey,
  type KeyAction,
} from "./keymap";
import { LiveZone } from "./LiveZone";
import { Approval } from "./overlays/Approval";
import { FilePicker } from "./overlays/FilePicker";
import { Question } from "./overlays/Question";
import { Search } from "./overlays/Search";
import { TextPrompt } from "./overlays/TextPrompt";
import { Transcript, type TranscriptHandle } from "./Transcript";
import { allocateRegions, wheelScrollDelta } from "./transcript-window";
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  type Focus,
  type Overlay,
  type ViewModel,
  type Viewport,
} from "./types";

/**
 * The shell: five stacked regions and a floating overlay layer.
 *
 * Everything here is layout and intent-routing. The regions are pure functions
 * of the view model, so a frame is reproducible from data alone — which is why
 * the layout can be asserted character by character in tests rather than
 * eyeballed.
 *
 * The ordering matters and is the design: the input and footer are anchored to
 * the bottom, a one-row gap sits above the composer, the live zone sits above
 * that, and the transcript takes whatever is left. So when work starts, the
 * live zone grows *upward* and the conversation yields the rows — the thing
 * under the user's hands never moves.
 */

/**
 * The modifiers a text field has to tell apart, which is more than "was a
 * modifier held".
 *
 * On macOS `super` is Cmd and `option`/`meta` is Option, and they mean
 * different things in every text field on the platform: Cmd+Left goes to the
 * start of the line, Option+Left goes back one word. Collapsing them into one
 * flag makes those two chords indistinguishable, which is exactly the bug that
 * made Cmd+Arrow behave wrongly. `ctrl` carries the Linux/Windows equivalents.
 */
export interface KeyChord {
  readonly name: string;
  /**
   * The bytes the terminal actually sent.
   *
   * This is what must be inserted when typing, never `name`: `name` is
   * lowercased for capitals — a shifted "X" arrives as `name: "x"` with
   * `shift: true` — so composing from `name` silently types everything in
   * lower case. `sequence` carries the true character. It is also what makes
   * the printable test trustworthy: a control key's sequence is either a
   * control code or a multi-character escape sequence, so "one printable code
   * point" excludes every arrow, function key and Ctrl chord without needing a
   * list of their names.
   */
  readonly sequence: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly option: boolean;
  readonly super: boolean;
  readonly focus: Focus;
}

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
  readonly onKey?: (key: KeyChord) => boolean;
  /**
   * First refusal on a bracketed paste (Cmd+V, Shift+Insert, middle-click).
   * Return true to consume it. Lives next to `onKey` so there is still one
   * place that decides whether the composer sees the text.
   */
  readonly onPaste?: (text: string) => boolean;
  /**
   * Replaces the five-region layout with arbitrary content — the wizard menu,
   * the screen-unavailable notice — while this component's own `useKeyboard`
   * call stays mounted.
   *
   * A hook runs for as long as the component that calls it is mounted,
   * regardless of which branch of that component's own render it takes — but
   * not at all if a *different* component is rendered instead. Returning
   * `<Home />` directly from the bridge, above this component, was exactly
   * that mistake: `App` never mounted, so `useKeyboard` never ran, so every
   * key — including Ctrl+C — was silently unhandled. Routing every screen
   * through here is what keeps that from happening again.
   */
  readonly overrideContent?: React.ReactNode;
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
    <box style={{ width, height, flexDirection: "column", backgroundColor: THEME.canvas }}>
      <text style={{ fg: THEME.selected }}>{`jazz needs ${MIN_WIDTH}x${MIN_HEIGHT}`}</text>
      <text style={{ fg: THEME.muted }}>{`this terminal is ${width}x${height}`}</text>
      <text style={{ fg: THEME.muted }}>resize, or run with --no-tui</text>
    </box>
  );
}

function renderOverlay(
  overlay: Overlay,
  viewport: { width: number; height: number },
): React.ReactNode {
  switch (overlay.kind) {
    case "approval":
      return (
        <Approval
          model={overlay}
          viewport={viewport}
        />
      );
    case "search":
      return (
        <Search
          model={overlay}
          viewport={viewport}
        />
      );
    case "question":
      return (
        <Question
          model={overlay}
          viewport={viewport}
        />
      );
    case "text":
      return (
        <TextPrompt
          model={overlay}
          viewport={viewport}
        />
      );
    case "filepicker":
      return (
        <FilePicker
          model={overlay}
          viewport={viewport}
        />
      );
  }
}

export function reuseViewport(width: number, height: number, previous: Viewport): Viewport {
  if (previous.width === width && previous.height === height) return previous;
  return { width, height };
}

function AppView({ view, onAction, onKey, onPaste, overrideContent }: AppProps): React.ReactNode {
  const { width, height } = useTerminalDimensions();
  const renderer = useRenderer();
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const [focus, setFocus] = useState<Focus>("input");
  const focusRef = useRef<Focus>("input");
  const transcriptRef = useRef<TranscriptHandle | null>(null);
  const [newBelow, setNewBelow] = useState<number | undefined>(view.newBelow);
  const seenBlocks = useRef(view.blocks.length);
  const armedAt = useRef<number | undefined>(undefined);
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined);
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const glyphs = getGlyphs();

  // `useKeyboard` registers its callback once, so it captures the props and
  // state setters from the render that happened to be first. Those setters can
  // belong to an instance React has since discarded, in which case the update is
  // silently dropped — the updater function is never even invoked. Calling
  // through a ref that every render refreshes means the handler is always the
  // live one.
  const onKeyRef = useRef<AppProps["onKey"]>(undefined);
  const onPasteRef = useRef<AppProps["onPaste"]>(undefined);
  const onActionRef = useRef(onAction);
  const viewRef = useRef(view);
  onKeyRef.current = onKey;
  onPasteRef.current = onPaste;
  onActionRef.current = onAction;
  viewRef.current = view;

  const overlayOpen = view.overlay !== undefined;

  const dispatch = useCallback((action: KeyAction) => {
    switch (action.type) {
      case "focus-input":
        focusRef.current = "input";
        setFocus("input");
        break;
      case "focus-transcript":
        focusRef.current = "transcript";
        setFocus("transcript");
        break;
      case "arm-interrupt":
        armedAt.current = Date.now();
        break;
      case "interrupt":
        armedAt.current = undefined;
        break;
      case "scroll-transcript":
        transcriptRef.current?.scrollBy(action.delta, action.unit);
        break;
      default:
        break;
    }
    onActionRef.current(action);
  }, []);

  const scrollTranscriptByWheel = useCallback(
    (direction: string, delta: number): void => {
      const amount = wheelScrollDelta(direction, delta);
      if (amount === null) return;
      if (focusRef.current !== "transcript") dispatch({ type: "focus-transcript" });
      transcriptRef.current?.scrollBy(amount, "line");
    },
    [dispatch],
  );

  const announceCopy = useCallback((copied: boolean): void => {
    if (!copied) return;
    if (copyNoticeTimer.current !== undefined) clearTimeout(copyNoticeTimer.current);
    setCopyNotice("copied");
    copyNoticeTimer.current = setTimeout(() => {
      setCopyNotice(undefined);
      copyNoticeTimer.current = undefined;
    }, 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (copyNoticeTimer.current !== undefined) clearTimeout(copyNoticeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (view.runActive !== true) armedAt.current = undefined;
  }, [view.runActive]);

  useEffect(() => {
    if (focus === "input") {
      seenBlocks.current = view.blocks.length;
      setNewBelow(undefined);
      return;
    }
    const added = view.blocks.length - seenBlocks.current;
    setNewBelow(added > 0 ? added : undefined);
  }, [focus, view.blocks.length]);

  useKeyboard((key) => {
    const currentView = viewRef.current;
    const currentOverlayOpen = currentView.overlay !== undefined;
    const currentFocus = focusRef.current;
    const { name, sequence, ctrl, shift, meta, option, super: superKey } = normalizeKey(key);

    // Ctrl+C is stop. Cmd+C and Ctrl+Shift+C are copy — different keys, and
    // OpenTUI is mounted with exitOnCtrlC: false so none of them quit by default.
    if (isInterruptChord({ name, ctrl, shift, super: superKey, sequence })) {
      consumeKeyEvent(key);
      if (
        onKeyRef.current?.({
          name,
          sequence,
          ctrl,
          shift,
          meta,
          option,
          super: superKey,
          focus: currentFocus,
        }) === true
      ) {
        return;
      }
      const running =
        currentView.runActive === true ||
        currentView.live.tools.length > 0 ||
        currentView.live.waiting !== undefined;
      if (running) dispatch({ type: "interrupt" });
      else process.kill(process.pid, "SIGINT");
      return;
    }

    if (isCopyChord({ name, ctrl, shift, super: superKey })) {
      const composer = selectedComposerText({
        text: currentView.input.value,
        caret: currentView.input.caret ?? [...currentView.input.value].length,
        anchor:
          currentView.input.anchor ??
          currentView.input.caret ??
          [...currentView.input.value].length,
      });
      const selected =
        composer.length > 0 ? composer : selectedTextFromRenderer(rendererRef.current);
      if (selected.length > 0) {
        consumeKeyEvent(key);
        void copyText(selected, rendererRef.current).then(announceCopy);
      }
      return;
    }

    // The caller gets the key first, so the composer and the overlays see
    // typing before focus and Esc handling do.
    if (
      onKeyRef.current?.({
        name,
        sequence,
        ctrl,
        shift,
        meta,
        option,
        super: superKey,
        focus: currentFocus,
      }) === true
    ) {
      consumeKeyEvent(key);
      if (
        !currentOverlayOpen &&
        currentFocus === "transcript" &&
        (isPrintableSequence(sequence, ctrl, superKey) || isCtrlLetter({ name, ctrl }, "v"))
      ) {
        dispatch({ type: "focus-input" });
      }
      return;
    }

    if (name === "escape") {
      consumeKeyEvent(key);
      dispatch(
        resolveEscape(
          {
            overlayOpen: currentOverlayOpen,
            searchActive: currentView.overlay?.kind === "search",
            completionOpen: false,
            runActive:
              currentView.runActive === true ||
              currentView.live.tools.length > 0 ||
              currentView.live.waiting !== undefined,
            ...(armedAt.current === undefined ? {} : { interruptArmedAt: armedAt.current }),
            hasQueued: currentView.input.queued.length > 0,
            inputEmpty: currentView.input.value.length === 0,
            focus: currentFocus,
          },
          Date.now(),
        ),
      );
      return;
    }

    // An overlay owns the keyboard while it is open, except page keys: those
    // still move the conversation so a question cannot bury the chat.
    if (currentOverlayOpen) {
      if (name === "pageup" || name === "pagedown") {
        consumeKeyEvent(key);
        dispatch({
          type: "scroll-transcript",
          delta: name === "pageup" ? -1 : 1,
          unit: "page",
        });
      }
      return;
    }

    const scrollAction = resolveScrollKey(name, currentFocus);
    if (scrollAction !== null) {
      consumeKeyEvent(key);
      if (currentFocus !== "transcript") dispatch({ type: "focus-transcript" });
      dispatch(scrollAction);
      return;
    }

    const focusAction = resolveFocusKey(name, currentFocus);
    if (focusAction.type !== "noop") {
      consumeKeyEvent(key);
      dispatch(focusAction);
    }
  });

  usePaste((event) => {
    const text = pasteTextFromEvent(event);
    if (text.length === 0) return;
    if (onPasteRef.current?.(text) === true) {
      consumeKeyEvent(event);
      if (viewRef.current.overlay === undefined && focusRef.current === "transcript") {
        dispatch({ type: "focus-input" });
      }
    }
  });

  // Mouse reporting replaces native drag-select, so Cmd+C in the host often
  // copies nothing. Releasing a highlight writes the clipboard immediately;
  // Cmd+C / Ctrl+Shift+C still copy whatever is highlighted. The footer says
  // "copied" for a beat so a silent pasteboard write is not the only signal.
  useSelectionHandler((selection) => {
    void copyText(textFromSelection(selection), rendererRef.current).then(announceCopy);
  });

  const viewportRef = useRef<Viewport>({ width, height });
  viewportRef.current = reuseViewport(width, height, viewportRef.current);
  const viewport = viewportRef.current;
  const inputModel = useMemo(
    () => ({ ...view.input, disabled: view.input.disabled || overlayOpen }),
    [view.input, overlayOpen],
  );
  const overlayKind = view.overlay?.kind;
  const overlayArmed = view.overlay?.kind === "approval" ? view.overlay.armed : true;
  const footerHints = useMemo(
    () =>
      hintsFor(
        focus,
        view.runActive === true,
        view.input.queueing === true,
        overlayKind,
        view.input.commands !== undefined,
        overlayArmed,
        view.input.queued.length > 0,
      ),
    [
      focus,
      view.runActive,
      view.input.queueing,
      overlayKind,
      view.input.commands,
      overlayArmed,
      view.input.queued.length,
    ],
  );
  const footer = useMemo(
    () => ({
      ...view.footer,
      hints: footerHints,
      ...(copyNotice === undefined ? {} : { notice: copyNotice }),
    }),
    [view.footer, footerHints, copyNotice],
  );

  if (overrideContent !== undefined) {
    return overrideContent;
  }

  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return (
      <TooSmall
        width={width}
        height={height}
      />
    );
  }

  const inputFocused = focus === "input" && !overlayOpen;
  // One allocation, shared by all three regions. Computing the transcript's
  // share here and letting the other two size themselves independently is how
  // the rows stopped adding up to more than the terminal has.
  const regions = allocateRegions({
    viewport,
    live: view.live,
    input: inputModel,
    inputFocused,
  });
  const visibleCount = regions.transcript;

  return (
    <box
      style={{ width, height, flexDirection: "column", backgroundColor: THEME.canvas }}
      onMouseScroll={(event) => {
        if (overlayOpen) return;
        const scroll = event.scroll;
        if (scroll === undefined) return;
        scrollTranscriptByWheel(scroll.direction, scroll.delta);
      }}
    >
      <Header
        model={view.header}
        viewport={viewport}
      />

      <box style={{ height: 1, flexShrink: 0 }}>
        <text style={{ fg: THEME.border }}>
          {`${glyphs.rail}${glyphs.divider.repeat(Math.max(0, width - 1))}`}
        </text>
      </box>

      <box
        style={{
          width,
          height: visibleCount,
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          maxHeight: visibleCount,
          overflow: "hidden",
          flexDirection: "column",
        }}
      >
        <Transcript
          ref={transcriptRef}
          blocks={view.blocks}
          viewport={viewport}
          focus={focus}
          visibleCount={visibleCount}
          followLive={focus === "input" && newBelow === undefined && !overlayOpen}
          {...(newBelow === undefined ? {} : { newBelow })}
        />
      </box>

      <LiveZone
        model={view.live}
        viewport={viewport}
        maxRows={regions.live}
      />
      <box style={{ width, height: 1, flexShrink: 0 }} />
      <Input
        model={inputModel}
        viewport={viewport}
        focused={inputFocused}
        maxRows={regions.input}
      />
      <Footer
        model={footer}
        viewport={viewport}
      />

      {view.overlay === undefined ? null : renderOverlay(view.overlay, viewport)}
    </box>
  );
}

export const App = memo(AppView);

/**
 * The keyboard shortcuts of each interface, as data.
 *
 * Jazz has two keyboard stacks: the classic inline interface (Ink, `App.tsx`,
 * `Prompt.tsx`, `QueueInput.tsx` and `input/escape-state-machine.ts`) and the
 * fullscreen one (OpenTUI, `fullscreen/bridge.tsx`, `fullscreen/App.tsx` and
 * `fullscreen/keymap.ts`). They bind different keys, so each has its own table
 * here. /help shows the table of the interface that is running (see
 * `setActiveKeymap`), and `bun run docs:chat-commands` writes both into
 * `docs/commands.md`.
 *
 * A binding added to or changed in either stack changes its table here too;
 * the table is what users are told.
 */

/** Which keyboard stack is live. */
export type KeymapMode = "classic" | "fullscreen";

/** One shortcut: the keys, when it applies, and what it does. */
export interface KeyBinding {
  readonly keys: string;
  readonly action: string;
  /** The state the binding needs, e.g. "agent busy". Absent means always. */
  readonly when?: string;
}

/** Bindings shared word for word by both interfaces. */
const COMPOSER_BINDINGS: readonly KeyBinding[] = [
  { keys: "Enter", action: "Send the message" },
  { keys: "Shift+Enter", action: "Insert a newline for a multi-line message" },
  { keys: "Tab", action: "Complete the highlighted slash command or @ path" },
  { keys: "Up/Down", action: "Recall previously sent messages", when: "empty input" },
  { keys: "Ctrl+A / Ctrl+E", action: "Move to the start or end of the line" },
  { keys: "Ctrl+U", action: "Delete from the caret to the start of the line" },
];

const RUN_BINDINGS: readonly KeyBinding[] = [
  { keys: "Ctrl+C", action: "Interrupt the current generation or tool", when: "agent busy" },
  { keys: "Ctrl+C Ctrl+C", action: "Leave the conversation" },
  { keys: "Shift+Tab", action: "Toggle safe/yolo approval mode" },
  { keys: "Ctrl+R", action: "Expand collapsed reasoning (repeat for earlier blocks)" },
  { keys: "Ctrl+O", action: "Expand the last truncated diff or tool output" },
  { keys: "Up", action: "Recall queued messages for editing", when: "agent busy" },
  { keys: "Ctrl+X", action: "Clear the message queue", when: "agent busy, empty input" },
];

/** The classic inline interface (`JAZZ_FULLSCREEN=0`, or a terminal fullscreen cannot use). */
export const CLASSIC_KEYMAP: readonly KeyBinding[] = [
  ...COMPOSER_BINDINGS,
  { keys: "Ctrl+K", action: "Delete from the caret to the end of the line" },
  { keys: "Ctrl+W", action: "Delete the word before the caret" },
  { keys: "Esc", action: "Clear the current draft" },
  {
    keys: "Esc Esc",
    action: "Interrupt the current generation or tool, and drop queued messages",
    when: "agent busy",
  },
  ...RUN_BINDINGS,
];

/** The fullscreen interface, the default on a capable terminal. */
export const FULLSCREEN_KEYMAP: readonly KeyBinding[] = [
  ...COMPOSER_BINDINGS,
  { keys: "Option+Enter", action: "Insert a newline for a multi-line message" },
  { keys: "Ctrl+V", action: "Paste from the clipboard" },
  { keys: "Ctrl+Z / Ctrl+Shift+Z", action: "Undo or redo an edit in the composer" },
  { keys: "Cmd+A", action: "Select the whole draft" },
  {
    keys: "Esc",
    action:
      "Close the open dialog, search, or menu; otherwise clear the draft; otherwise focus the transcript",
  },
  { keys: "Esc Esc", action: "Interrupt the current generation or tool", when: "agent busy" },
  {
    keys: "Esc Esc",
    action: "Interrupt and send the queued messages now",
    when: "agent busy, messages queued",
  },
  ...RUN_BINDINGS,
  { keys: "Ctrl+B", action: "Move the running tool call to the background", when: "tool running" },
  {
    keys: "Down",
    action: "Pick a sub-agent under the input; Enter opens its log",
    when: "sub-agents listed",
  },
  {
    keys: "Enter",
    action: "Send the draft to that sub-agent instead of the main chat",
    when: "sub-agent open",
  },
  { keys: "Esc", action: "Return to the main conversation", when: "sub-agent open" },
  { keys: "Ctrl+F", action: "Search the conversation" },
  { keys: "PgUp/PgDn", action: "Scroll the conversation" },
  {
    keys: "Up/Down, Home/End",
    action: "Scroll line by line or to either end; type to return to the input",
    when: "transcript focused",
  },
];

export const KEYMAPS: Readonly<Record<KeymapMode, readonly KeyBinding[]>> = {
  classic: CLASSIC_KEYMAP,
  fullscreen: FULLSCREEN_KEYMAP,
};

let activeMode: KeymapMode = "classic";

/** Record which interface is mounted, so /help shows its keys. */
export function setActiveKeymap(mode: KeymapMode): void {
  activeMode = mode;
}

/** The interface that is mounted. */
export function activeKeymapMode(): KeymapMode {
  return activeMode;
}

/** `keys (when)`, the way a binding is labeled in /help and the docs. */
export function bindingLabel(binding: KeyBinding): string {
  return binding.when === undefined ? binding.keys : `${binding.keys} (${binding.when})`;
}

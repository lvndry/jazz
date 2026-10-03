/**
 * What computer use may do in each app, decided by the app's bundle id.
 *
 * An app falls in exactly one class, and a person cannot raise it:
 *
 * - `refused`: no grant is possible. Controlling these apps would hand the model more authority
 *   than the tools Jazz already gates, or let it approve its own permissions.
 * - `view-only`: the window can be read and never acted on.
 * - `click-only`: clicks and scrolling, with no typing and no keyboard shortcuts.
 * - `full`: everything the tools offer. Every app not named below lands here.
 *
 * An app whose bundle id is unknown cannot be classified, so it is refused.
 */

export type AppTier = "view-only" | "click-only" | "full";

export type AppClass = AppTier | "refused";

/** What the computer tools do to a window. */
export type ActionKind = "observe" | "click" | "scroll" | "type" | "key";

const TIER_ACTIONS: Readonly<Record<AppTier, ReadonlySet<ActionKind>>> = {
  "view-only": new Set<ActionKind>(["observe"]),
  "click-only": new Set<ActionKind>(["observe", "click", "scroll"]),
  full: new Set<ActionKind>(["observe", "click", "scroll", "type", "key"]),
};

export function tierAllows(tier: AppTier, action: ActionKind): boolean {
  return TIER_ACTIONS[tier].has(action);
}

/**
 * Bundle ids no grant can cover, and why:
 *
 * - Terminal emulators run any command, so controlling one bypasses the shell tool's risk
 *   classification, denylist, approvals and secret redaction.
 * - Password managers and Keychain Access hold every credential on the machine.
 * - System Settings and the authorization and permission-prompt agents can change what this
 *   process is allowed to do, or approve the prompts that would grant it more.
 * - Automator, Script Editor and Shortcuts run arbitrary scripts.
 *
 * The list names the apps most likely to be present; an app that is missing from it is treated
 * as `full`, so it is a floor, not a guarantee.
 */
export const REFUSED_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty",
  "com.github.wez.wezterm",
  "org.alacritty",
  "co.zeit.hyper",
  "org.tabby",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
  "com.agilebits.onepassword7",
  "com.agilebits.onepassword-osx",
  "com.bitwarden.desktop",
  "org.keepassxc.keepassxc",
  "com.dashlane.dashlanephonefinal",
  "com.lastpass.lastpass",
  "com.apple.systempreferences",
  "com.apple.SecurityAgent",
  "com.apple.coreservices.uiagent",
  "com.apple.loginwindow",
  "com.apple.Automator",
  "com.apple.ScriptEditor2",
  "com.apple.shortcuts",
]);

/** Families of bundle ids that share a vendor prefix and the same reason for refusal. */
export const REFUSED_BUNDLE_ID_PREFIXES: readonly string[] = ["com.1password."];

/**
 * Browsers and trading apps. A browser can be signed in to anything, and the dedicated browser
 * tools read and drive pages with Jazz's own request guard, so the desktop tools only look.
 */
export const VIEW_ONLY_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.Safari",
  "com.google.Chrome",
  "com.google.Chrome.beta",
  "com.google.Chrome.canary",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "com.brave.Browser",
  "company.thebrowser.Browser",
  "com.operasoftware.Opera",
  "com.vivaldi.Vivaldi",
  "com.kagi.kagimacOS",
]);

/**
 * Editors, IDEs and the file manager. Typing into an editor writes code that later runs, and
 * typing into Finder renames or moves files, so these take clicks only.
 */
export const CLICK_ONLY_BUNDLE_IDS: ReadonlySet<string> = new Set([
  "com.apple.dt.Xcode",
  "com.apple.finder",
  "com.microsoft.VSCode",
  "com.microsoft.VSCodeInsiders",
  "com.todesktop.230313mzl4w4u92",
  "dev.zed.Zed",
  "com.sublimetext.4",
  "com.panic.Nova",
]);

/** Families of bundle ids that share a vendor prefix and the same tier. */
export const CLICK_ONLY_BUNDLE_ID_PREFIXES: readonly string[] = ["com.jetbrains."];

function hasPrefix(bundleId: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => bundleId.startsWith(prefix));
}

export function classifyApp(bundleId: string | null | undefined): AppClass {
  if (bundleId === null || bundleId === undefined || bundleId.trim().length === 0) {
    return "refused";
  }
  if (REFUSED_BUNDLE_IDS.has(bundleId) || hasPrefix(bundleId, REFUSED_BUNDLE_ID_PREFIXES)) {
    return "refused";
  }
  if (VIEW_ONLY_BUNDLE_IDS.has(bundleId)) {
    return "view-only";
  }
  if (CLICK_ONLY_BUNDLE_IDS.has(bundleId) || hasPrefix(bundleId, CLICK_ONLY_BUNDLE_ID_PREFIXES)) {
    return "click-only";
  }
  return "full";
}

export function describeRefusal(bundleId: string): string {
  return (
    `${bundleId} cannot be granted: controlling it would give the model authority Jazz gates ` +
    "elsewhere (a shell, your credentials, or your system permissions)."
  );
}

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "option",
  option: "option",
  opt: "option",
  shift: "shift",
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  backspace: "delete",
  del: "delete",
  forwarddelete: "delete",
};

function normalizeKey(name: string): string {
  const lower = name.trim().toLowerCase();
  return MODIFIER_ALIASES[lower] ?? KEY_ALIASES[lower] ?? lower;
}

/**
 * Shortcuts that end the session or destroy data without a confirmation step. Each is a set of
 * normalized key names; a pressed combination is blocked when it contains every name in a set.
 * This is defense in depth: the tier and the approval are the boundary.
 */
const BLOCKED_KEY_COMBOS: readonly (readonly string[])[] = [
  ["cmd", "shift", "delete"],
  ["ctrl", "cmd", "q"],
  ["cmd", "shift", "q"],
];

/** The reason a key combination is blocked, or undefined when it may be pressed. */
export function blockedKeyReason(keys: readonly string[]): string | undefined {
  const pressed = new Set(keys.map(normalizeKey));
  const blocked = BLOCKED_KEY_COMBOS.some((combo) => combo.every((name) => pressed.has(name)));
  return blocked
    ? "That shortcut empties the Trash, locks the screen or logs out, and computer use never presses it."
    : undefined;
}

/**
 * Text that, typed into a focused terminal-like field, would run a destructive or remote-code
 * command. Matched case-insensitively against typed text.
 */
const BLOCKED_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\bsudo\s+rm\s+-[a-z]*r[a-z]*f?\b/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\$HOME)(?:\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};\s*:/,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\s+if=.*\bof=\/dev\//i,
];

/** The reason typed text is blocked, or undefined when it may be typed. */
export function blockedTextReason(text: string): string | undefined {
  return BLOCKED_TEXT_PATTERNS.some((pattern) => pattern.test(text))
    ? "That text looks like a command that downloads and runs code or deletes data, and computer use never types it."
    : undefined;
}

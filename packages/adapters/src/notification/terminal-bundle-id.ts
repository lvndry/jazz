/**
 * Resolve the macOS bundle identifier for the current terminal emulator.
 * Used to focus the terminal when a notification is clicked.
 */
export function getTerminalBundleId(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  const termProgram = process.env["TERM_PROGRAM"];
  const term = process.env["TERM"];

  if (termProgram === "WarpTerminal") return "dev.warp.Warp-Stable";
  if (termProgram === "iTerm.app") return "com.googlecode.iterm2";
  if (termProgram === "Apple_Terminal") return "com.apple.Terminal";
  if (termProgram === "vscode") return "com.microsoft.VSCode";
  if (process.env["KITTY_WINDOW_ID"]) return "net.kovidgoyal.kitty";
  if (term?.includes("alacritty")) return "org.alacritty";
  if (termProgram === "WezTerm") return "com.github.wez.wezterm";
  if (termProgram === "ghostty") return "com.mitchellh.ghostty";

  return undefined;
}

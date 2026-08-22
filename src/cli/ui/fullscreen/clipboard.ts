import { spawn } from "node:child_process";
import { decodePasteBytes, stripAnsiSequences } from "@opentui/core";

function clipboardReadCommands(): ReadonlyArray<{
  readonly cmd: string;
  readonly args: readonly string[];
}> {
  switch (process.platform) {
    case "darwin":
      return [{ cmd: "pbpaste", args: [] }];
    case "win32":
      return [{ cmd: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard"] }];
    default:
      return [
        { cmd: "wl-paste", args: ["-n"] },
        { cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
        { cmd: "xsel", args: ["--clipboard", "--output"] },
      ];
  }
}

export function clipboardWriteCommands(
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<{
  readonly cmd: string;
  readonly args: readonly string[];
}> {
  switch (platform) {
    case "darwin":
      return [{ cmd: "pbcopy", args: [] }];
    case "win32":
      return [{ cmd: "clip", args: [] }];
    default:
      return [
        { cmd: "wl-copy", args: [] },
        { cmd: "xclip", args: ["-selection", "clipboard"] },
        { cmd: "xsel", args: ["--clipboard", "--input"] },
      ];
  }
}

export function selectedTextFromRenderer(renderer: {
  readonly hasSelection?: boolean;
  readonly getSelection?: () => { getSelectedText(): string } | null;
}): string {
  if (renderer.hasSelection !== true) return "";
  const selection = renderer.getSelection?.();
  if (selection === undefined || selection === null) return "";
  return normalizePaste(selection.getSelectedText());
}

export function normalizePaste(text: string): string {
  return stripAnsiSequences(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function flattenPaste(text: string): string {
  return normalizePaste(text).replace(/\n/g, " ");
}

export function pasteTextFromEvent(event: {
  readonly text?: unknown;
  readonly bytes?: unknown;
}): string {
  if (typeof event.text === "string") return normalizePaste(event.text);
  if (event.bytes instanceof Uint8Array) return normalizePaste(decodePasteBytes(event.bytes));
  return "";
}

export function readClipboard(): Promise<string> {
  const candidates = clipboardReadCommands();
  function tryCandidate(index: number): Promise<string> {
    return new Promise((resolve) => {
      const candidate = candidates[index];
      if (candidate === undefined) {
        resolve("");
        return;
      }
      const child = spawn(candidate.cmd, [...candidate.args]);
      const chunks: Buffer[] = [];
      let advanced = false;
      const advance = (): void => {
        if (advanced) return;
        advanced = true;
        resolve(tryCandidate(index + 1));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      child.on("error", advance);
      child.on("close", (code) => {
        if (advanced) return;
        if (code === 0) {
          advanced = true;
          resolve(normalizePaste(Buffer.concat(chunks).toString("utf8")));
          return;
        }
        advance();
      });
    });
  }
  return tryCandidate(0);
}

export function writeClipboard(text: string): Promise<boolean> {
  const candidates = clipboardWriteCommands();
  function tryCandidate(index: number): Promise<boolean> {
    return new Promise((resolve) => {
      const candidate = candidates[index];
      if (candidate === undefined) {
        resolve(false);
        return;
      }
      const child = spawn(candidate.cmd, [...candidate.args]);
      let advanced = false;
      const advance = (): void => {
        if (advanced) return;
        advanced = true;
        resolve(tryCandidate(index + 1));
      };
      child.stdin.on("error", advance);
      child.on("error", advance);
      child.on("close", (code) => {
        if (advanced) return;
        if (code === 0) {
          advanced = true;
          resolve(true);
          return;
        }
        advance();
      });
      child.stdin.write(text);
      child.stdin.end();
    });
  }
  return tryCandidate(0);
}

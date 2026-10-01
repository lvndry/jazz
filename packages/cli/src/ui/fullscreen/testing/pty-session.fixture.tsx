/**
 * Deterministic compiled-session fixture for PTY qualification. It mounts the
 * production store, bridge, terminal lifecycle and React application without a
 * provider. A private temporary control file supplies validated test commands;
 * keyboard and mouse bytes still traverse the actual terminal input parser.
 * Native expected grids are written to the private result file on request.
 */
import { writeFileSync } from "node:fs";
import { CliRenderEvents } from "@opentui/core";
import { z } from "zod";
import { store } from "../../store";
import { mountFullscreenApp } from "../attach";
import { mountFullscreen, type MountedRenderer } from "../mount";
import { nativeGrid } from "./terminal-oracle";

function fixturePath(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error("Missing private PTY fixture path");
  return value;
}
const controlPath = fixturePath("JAZZ_PTY_CONTROL");
const resultPath = fixturePath("JAZZ_PTY_RESULT");
const commandSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  action: z.enum(["burst", "noise", "capture", "exit"]),
});
let mounted: MountedRenderer | undefined;
let sequence = -1;
let reading = false;
store.setStreamPacing(false);
store.setCurrentConversation({ agentId: "pty-test", conversationId: "pty-session" });
store.resetRunStats({ model: "PTY-model" });
store.setPrompt({ type: "chat", message: "", resolve: () => undefined });
store.replaceDocument("pty-session:main", [
  {
    id: "history",
    timestamp: "2026-10-01T10:00:00.000Z",
    content: {
      kind: "agent",
      markdown: Array.from(
        { length: 100 },
        (_, index) => `history-${String(index).padStart(3, "0")}`,
      ).join("\n\n"),
    },
  },
]);
const handle = mountFullscreenApp({
  mount: async () => {
    mounted = await mountFullscreen();
    return mounted;
  },
  onFailure: (error) => {
    writeFileSync(resultPath, JSON.stringify({ failure: String(error) }), { mode: 0o600 });
    process.exit(2);
  },
});

/** Private control transport never uses the terminal output stream or composer input. */
async function readCommand(): Promise<void> {
  if (reading || mounted === undefined) return;
  reading = true;
  try {
    const parsed = commandSchema.safeParse(await Bun.file(controlPath).json());
    if (!parsed.success || parsed.data.sequence <= sequence) return;
    sequence = parsed.data.sequence;
    switch (parsed.data.action) {
      case "burst":
        for (let index = 0; index < 40; index++) {
          store.printContent({
            kind: "tool",
            receipt: { app: "read_file", summary: `receipt-${sequence}-${index}`, status: "ok" },
          });
        }
        store.appendStream("response", `\n\nanswerMARK-${sequence} 界 e\u0301\n\n`);
        store.finalizeStream();
        break;
      case "noise":
      case "capture":
        if (parsed.data.action === "noise") process.stdout.write("\u001b[2J\u001b[H");
        await new Promise<void>((resolve, reject) => {
          const renderer = mounted?.renderer;
          if (renderer === undefined) {
            reject(new Error("Renderer missing"));
            return;
          }
          const onFrame = (): void => {
            clearTimeout(timeout);
            resolve();
          };
          const timeout = setTimeout(() => {
            renderer.off(CliRenderEvents.FRAME, onFrame);
            reject(new Error("Native frame capture timed out"));
          }, 5_000);
          renderer.once(CliRenderEvents.FRAME, onFrame);
          renderer.requestRender();
        });
        await Bun.write(
          resultPath,
          JSON.stringify({ sequence, grid: nativeGrid(mounted.renderer.currentRenderBuffer) }),
        );
        break;
      case "exit":
        clearInterval(timer);
        handle.release();
        process.exit(0);
    }
  } finally {
    reading = false;
  }
}
const timer = setInterval(() => void readCommand().catch(() => process.exit(3)), 10);

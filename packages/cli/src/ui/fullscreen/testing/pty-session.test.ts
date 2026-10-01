/**
 * Qualifies compiled production terminal ownership through a real PTY. The
 * independent VT observer verifies the visible screen after navigation, tool
 * bursts, foreign control writes, resize and composer input. Only deterministic
 * fixture content is used; no provider, credentials or user state are accessed.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { compareTerminalGrids, createVtObserver, type TerminalGrid } from "./terminal-oracle";

const gridSchema = z.strictObject({
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  cells: z.array(
    z.array(z.strictObject({ chars: z.string(), width: z.number().int().min(0).max(2) })),
  ),
});
const resultSchema = z.strictObject({ sequence: z.number().int().nonnegative(), grid: gridSchema });
const gridText = (grid: TerminalGrid): string =>
  grid.cells.map((row) => row.map((cell) => cell.chars).join("")).join("\n");

test.skipIf(process.platform === "win32")(
  "compiled session keeps history, follows End, repairs terminal ownership and accepts input",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "jazz-ui-pty-"));
    const controlPath = join(directory, "control.json");
    const resultPath = join(directory, "result.json");
    const binary = join(directory, "session");
    const observer = createVtObserver(80, 24);
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let sequence = 0;
    let transport = "";

    /** Await an observed terminal state, never a fixed sleep as evidence of successful painting. */
    async function waitFor(check: (grid: TerminalGrid) => boolean): Promise<TerminalGrid> {
      const started = performance.now();
      for (;;) {
        await observer.drain();
        const grid = observer.captureGrid();
        if (check(grid)) return grid;
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
          const failure = z.strictObject({ failure: z.string() }).safeParse(
            await Bun.file(resultPath)
              .json()
              .catch(() => null),
          );
          throw new Error(
            `Compiled PTY session exited early (${child.exitCode}): ${failure.success ? failure.data.failure : Bun.stripANSI(transport).slice(-2000)}`,
          );
        }
        if (performance.now() - started > 10_000)
          throw new Error(
            `Compiled PTY session did not reach the expected screen: ${gridText(grid)}`,
          );
        await Bun.sleep(10);
      }
    }

    async function command(action: "burst" | "noise" | "capture" | "exit"): Promise<number> {
      const current = ++sequence;
      await writeFile(controlPath, JSON.stringify({ sequence: current, action }), { mode: 0o600 });
      return current;
    }

    async function waitResult(current: number): Promise<TerminalGrid> {
      const started = performance.now();
      for (;;) {
        const parsed = resultSchema.safeParse(
          await Bun.file(resultPath)
            .json()
            .catch(() => null),
        );
        if (parsed.success && parsed.data.sequence === current) return parsed.data.grid;
        if (performance.now() - started > 5_000)
          throw new Error("Native expected grid was not captured");
        await Bun.sleep(10);
      }
    }

    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "pty-session.fixture.tsx")],
        target: "bun",
        format: "esm",
        minify: true,
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [
          {
            name: "fixture-optional-devtools",
            setup(build) {
              build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
                path: args.path,
                namespace: "fixture-devtools",
              }));
              build.onLoad({ filter: /.*/, namespace: "fixture-devtools" }, () => ({
                contents: "export default {};",
                loader: "js",
              }));
            },
          },
        ],
        compile: { outfile: binary },
      });
      if (!built.success)
        throw new Error(
          `PTY fixture compilation failed: ${built.logs.map((log) => log.message).join("\n")}`,
        );
      await writeFile(controlPath, JSON.stringify({ sequence: 0, action: "capture" }), {
        mode: 0o600,
      });
      child = Bun.spawn([binary], {
        cwd: directory,
        env: {
          ...process.env,
          JAZZ_HOME: directory,
          JAZZ_OFFLINE: "1",
          JAZZ_PTY_CONTROL: controlPath,
          JAZZ_PTY_RESULT: resultPath,
          TERM: "xterm-256color",
          FORCE_COLOR: "3",
        },
        terminal: {
          cols: 80,
          rows: 24,
          data: (_terminal, data) => {
            transport = (transport + Buffer.from(data).toString("utf8")).slice(-4000);
            observer.accept(data);
          },
        },
      });
      const terminal = child.terminal;
      if (terminal === undefined) throw new Error("PTY was not created");
      await waitFor((grid) => gridText(grid).includes("history-099"));
      terminal.write("\u001b[5~");
      const detached = await waitFor(
        (grid) => gridText(grid).includes("history-090") && !gridText(grid).includes("history-099"),
      );
      const history = gridText(detached).match(/history-\d+/g);
      const burst = await command("burst");
      await waitFor((grid) => gridText(grid).includes("new below"));
      await observer.drain();
      expect(gridText(observer.captureGrid()).match(/history-\d+/g)).toEqual(history);
      terminal.write("\u001b[F");
      await waitFor((grid) => gridText(grid).includes(`answerMARK-${burst}`));
      const second = await command("burst");
      await waitFor((grid) => gridText(grid).includes(`answerMARK-${second}`));
      terminal.write("composerMARK");
      await waitFor((grid) => gridText(grid).includes("composerMARK"));
      await waitResult(await command("noise"));
      await observer.drain();
      expect(gridText(observer.captureGrid())).toContain(`answerMARK-${second}`);
      expect(gridText(observer.captureGrid())).toContain("composerMARK");

      await observer.drain();
      observer.resize(100, 30);
      terminal.resize(100, 30);
      await waitFor(
        (grid) =>
          gridText(grid).includes(`answerMARK-${second}`) &&
          gridText(grid).includes("composerMARK"),
      );
      let expected = await waitResult(await command("capture"));
      const resizeStarted = performance.now();
      while (expected.columns !== 100 || expected.rows !== 30) {
        if (performance.now() - resizeStarted > 5_000)
          throw new Error(
            `Native PTY resize did not reach 100x30 (${expected.columns}x${expected.rows})`,
          );
        await Bun.sleep(10);
        expected = await waitResult(await command("capture"));
      }
      await observer.drain();
      expect(compareTerminalGrids(expected, observer.captureGrid())).toEqual([]);
      await command("exit");
      expect(await child.exited).toBe(0);
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      child?.terminal?.close();
      await observer.drain();
      observer.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

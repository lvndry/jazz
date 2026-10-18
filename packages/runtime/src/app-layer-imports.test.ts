import { describe, expect, it } from "bun:test";

/** Loading the composition root from source takes seconds on a loaded machine. */
const IMPORT_TIMEOUT_MS = 60_000;

/**
 * Modules every command would pay for if the composition root imported them eagerly: the Ink
 * renderer and React, the chat implementation, and the daemon's HTTP server.
 */
const INTERACTIVE_ONLY_MODULES = [
  "/node_modules/ink/",
  "/node_modules/react/",
  "/node_modules/hono/",
  "/packages/cli/src/chat-service.ts",
  "/packages/cli/src/terminal.ts",
];

describe("app-layer imports", () => {
  it(
    "leave the interactive UI, chat and daemon server unloaded",
    async () => {
      const script = `await import(${JSON.stringify(`${import.meta.dir}/app-layer.ts`)}); console.log(JSON.stringify(Object.keys(require.cache)));`;
      const child = Bun.spawn(["bun", "--eval", script], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      const loaded: string[] = JSON.parse(stdout);
      const interactiveLoaded = loaded.filter((modulePath) =>
        INTERACTIVE_ONLY_MODULES.some((fragment) => modulePath.includes(fragment)),
      );
      expect(interactiveLoaded).toEqual([]);
    },
    IMPORT_TIMEOUT_MS,
  );
});

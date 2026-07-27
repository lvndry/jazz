import { Effect } from "effect";
import { createCLIApp } from "./cli/cli-app";

// The `ai` SDK's default warning logger writes its one-time banner via console.info, which is
// STDOUT — this corrupts `jazz run --json`'s output contract (stdout must be JSON only), and
// crashes JSON.parse for any consumer parsing it. Route warnings to stderr instead, where CLI
// diagnostics belong and where they can't break structured output.
globalThis.AI_SDK_LOG_WARNINGS = (options) => {
  console.error(
    "AI SDK warning:",
    JSON.stringify(options.warnings),
    options.provider,
    options.model,
  );
};

/**
 * Main entry point for the Jazz CLI
 */

function main(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Eval-only, env-gated: install a deterministic fetch record/replay wrapper
    // before any tool can run. Dynamic import keeps this zero-cost in normal runs.
    if (process.env["JAZZ_WEB_CASSETTE"]) {
      const { installWebCassette } = yield* Effect.promise(
        () => import("./core/eval/web-cassette"),
      );
      installWebCassette(
        process.env["JAZZ_WEB_CASSETTE"],
        process.env["JAZZ_WEB_MODE"] === "record" ? "record" : "replay",
      );
    }
    const program = yield* createCLIApp();
    program.parse();
  });
}

Effect.runPromise(main()).catch((error) => {
  console.error("Fatal error:", error);
  throw error;
});

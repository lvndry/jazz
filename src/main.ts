#!/usr/bin/env node

import { Effect } from "effect";
import { createCLIApp } from "./cli/cli-app";

/**
 * Main entry point for the Jazz CLI
 */

function main(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const program = yield* createCLIApp();
    program.parse();
  });
}

Effect.runPromise(main()).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

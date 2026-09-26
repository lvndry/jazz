/**
 * A logger for tests that must provide one but assert nothing about what it logs.
 */
import { Effect } from "effect";
import type { LoggerService } from "@/core/interfaces/logger";

export const silentLogger: LoggerService = {
  debug: () => Effect.void,
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
  writeToFile: () => Effect.void,
  logToolCall: () => Effect.void,
  setLogGroup: () => Effect.void,
  clearLogGroup: () => Effect.void,
  pushLogGroup: () => Effect.void,
  popLogGroup: () => Effect.void,
};

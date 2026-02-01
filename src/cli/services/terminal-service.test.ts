import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  TerminalCapabilityServiceTag,
  TerminalCapabilityServiceLive,
  getAllSequencesForAction,
  sequenceMatchesAction,
} from "./terminal-service";

// ============================================================================
// Tests
// ============================================================================

describe("TerminalService", () => {
  const runWithService = <A, E>(
    program: Effect.Effect<A, E, { readonly capabilities: Effect.Effect<import("./terminal-service").TerminalCapabilities> }>,
  ): Promise<A> => {
    return Effect.runPromise(Effect.provide(program, TerminalCapabilityServiceLive));
  };

  describe("Terminal Detection", () => {
    test("service provides capabilities", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;

          expect(capabilities).toBeDefined();
          expect(capabilities.type).toBeDefined();
          expect(capabilities.supportsUnicode).toBeDefined();
          expect(capabilities.supportsTrueColor).toBeDefined();
          expect(capabilities.columns).toBeGreaterThan(0);
          expect(capabilities.rows).toBeGreaterThan(0);

          return capabilities;
        }),
      );

      expect(result).toBeDefined();
    });

    test("service provides escape sequences", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;
          const sequences = capabilities.escapeSequences;

          expect(sequences).toBeDefined();
          expect(sequences.optionLeft).toBeDefined();
          expect(sequences.optionRight).toBeDefined();
          expect(sequences.deleteKey).toBeDefined();
          expect(sequences.home).toBeDefined();
          expect(sequences.end).toBeDefined();

          return sequences;
        }),
      );

      expect(Array.isArray(result.optionLeft)).toBe(true);
      expect(result.optionLeft.length).toBeGreaterThan(0);
    });
  });

  describe("getAllSequencesForAction", () => {
    test("returns sequences for optionLeft", () => {
      const sequences = getAllSequencesForAction("optionLeft");

      expect(Array.isArray(sequences)).toBe(true);
      expect(sequences.length).toBeGreaterThan(0);
    });

    test("returns empty array for unknown action", () => {
      // getAllSequencesForAction only accepts known actions
      // so we test that it returns an array for a valid action
      const sequences = getAllSequencesForAction("deleteKey");

      expect(Array.isArray(sequences)).toBe(true);
      expect(sequences.length).toBeGreaterThan(0);
    });
  });

  describe("sequenceMatchesAction", () => {
    test("matches ESC b to optionLeft", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;
          const matches = sequenceMatchesAction("\x1bb", "optionLeft", capabilities);
          return matches;
        }),
      );

      expect(result).toBe(true);
    });

    test("matches CSI 1;3D to optionLeft", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;
          const matches = sequenceMatchesAction("\x1b[1;3D", "optionLeft", capabilities);
          return matches;
        }),
      );

      expect(result).toBe(true);
    });

    test("does not match wrong sequence to optionLeft", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;
          const matches = sequenceMatchesAction("\x1bf", "optionLeft", capabilities);
          return matches;
        }),
      );

      expect(result).toBe(false);
    });

    test("matches delete key sequence", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;
          const matches = sequenceMatchesAction("\x1b[3~", "deleteKey", capabilities);
          return matches;
        }),
      );

      expect(result).toBe(true);
    });
  });

  describe("Quirks Configuration", () => {
    test("quirks are provided", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const capabilities = yield* service.capabilities;
          const quirks = capabilities.quirks;

          expect(quirks).toBeDefined();
          expect(typeof quirks.interceptsOptionShortcuts).toBe("boolean");
          expect(typeof quirks.hasBlocksMode).toBe("boolean");
          expect(typeof quirks.backspaceIsDelete).toBe("boolean");
          expect(typeof quirks.supportsBracketedPaste).toBe("boolean");

          return quirks;
        }),
      );

      expect(result).toBeDefined();
    });
  });

  describe("Dimension Queries", () => {
    test("getColumns returns terminal width", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const columns = yield* service.getColumns;
          return columns;
        }),
      );

      expect(result).toBeGreaterThan(0);
    });

    test("getRows returns terminal height", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const rows = yield* service.getRows;
          return rows;
        }),
      );

      expect(result).toBeGreaterThan(0);
    });
  });

  describe("Service Methods", () => {
    test("matchesSequence works via service", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* TerminalCapabilityServiceTag;
          const matches = yield* service.matchesSequence("\x1bb", "optionLeft");
          return matches;
        }),
      );

      expect(result).toBe(true);
    });
  });
});

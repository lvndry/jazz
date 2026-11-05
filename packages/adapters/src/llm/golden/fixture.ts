/**
 * The on-disk shape of a golden session fixture and the recorder that writes one.
 *
 * A fixture holds one entry per model call, in order. Each entry has the request summary the
 * recording saw (message roles, tool names offered, tool results fed back) and the AI SDK
 * `fullStream` parts the model produced for that call, exactly as `streamText` yielded them.
 * Replay feeds those parts to the real `StreamProcessor`, so everything downstream of the
 * provider boundary runs for real.
 *
 * Authors record a session by running Jazz with `JAZZ_GOLDEN_RECORD=<fixture path>`: the AI SDK
 * service then calls `createGoldenRecorder`, which scrubs every call as it arrives and rewrites
 * the fixture file after each model call. CI never records; it only replays committed fixtures.
 * Request summaries hold roles and tool names, never message text, except tool results, which
 * are scrubbed and kept so a scenario can script the same results.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createScrubber, type Scrubber, type ScrubberOptions } from "./scrub";

export const GOLDEN_FIXTURE_VERSION = 1;

/** An AI SDK `fullStream` part, kept as the loosely-typed JSON the provider boundary yields. */
export type GoldenStreamPart = { readonly type: string } & Readonly<Record<string, unknown>>;

export interface GoldenToolResult {
  readonly toolName: string;
  readonly content: string;
}

/** What a model call was asked, summarized to what drift detection compares. */
export interface GoldenRequestSummary {
  readonly messageRoles: readonly string[];
  readonly toolNames: readonly string[];
  readonly toolResults: readonly GoldenToolResult[];
}

export interface GoldenCall {
  readonly request: GoldenRequestSummary;
  readonly parts: readonly GoldenStreamPart[];
}

export interface GoldenFixture {
  readonly version: typeof GOLDEN_FIXTURE_VERSION;
  readonly scenario: string;
  readonly provider: string;
  readonly model: string;
  readonly calls: readonly GoldenCall[];
}

/** One call being recorded: the request is known up front, the parts arrive as the stream runs. */
export interface CallRecording {
  observePart(part: unknown): void;
  finish(): void;
}

export interface GoldenRecorder {
  beginCall(request: GoldenRequestSummary): CallRecording;
  readonly fixture: () => GoldenFixture;
}

export interface GoldenRecorderOptions extends ScrubberOptions {
  readonly path: string;
  readonly scenario: string;
  readonly provider: string;
  readonly model: string;
}

/** Keys that carry the request body or provider internals, which replay does not read. */
const OMITTED_PART_KEYS: ReadonlySet<string> = new Set([
  "request",
  "response",
  "rawValue",
  "providerMetadata",
  "warnings",
]);

function toJsonValue(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, child: unknown) => {
      if (OMITTED_PART_KEYS.has(key)) {
        return undefined;
      }
      return typeof child === "bigint" ? child.toString() : child;
    }),
  );
}

export function createGoldenRecorder(options: GoldenRecorderOptions): GoldenRecorder {
  const scrubber: Scrubber = createScrubber(options);
  const calls: GoldenCall[] = [];

  const snapshot = (): GoldenFixture => ({
    version: GOLDEN_FIXTURE_VERSION,
    scenario: options.scenario,
    provider: options.provider,
    model: options.model,
    calls: [...calls],
  });

  const write = (): void => {
    mkdirSync(dirname(options.path), { recursive: true });
    writeFileSync(options.path, `${JSON.stringify(snapshot(), null, 2)}\n`);
  };

  return {
    fixture: snapshot,
    beginCall(request) {
      const parts: GoldenStreamPart[] = [];
      const scrubbedRequest = scrubber.scrub({
        messageRoles: [...request.messageRoles],
        toolNames: [...request.toolNames],
        toolResults: request.toolResults.map((result) => ({ ...result })),
      });
      return {
        observePart(part) {
          parts.push(scrubber.scrub(toJsonValue(part)) as GoldenStreamPart);
        },
        finish() {
          calls.push({ request: scrubbedRequest, parts });
          write();
        },
      };
    },
  };
}

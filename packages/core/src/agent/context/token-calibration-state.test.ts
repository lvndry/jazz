import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { hydrateTokenCalibration, saveTokenCalibration } from "./token-calibration-state";
import { DEFAULT_TOKEN_COUNTER, TokenCounter, type ModelHint } from "./token-counter";

// The counter learns ratios per model; anthropic has no exact tokenizer, so
// its calibration is exactly what persistence exists for.
const HINT: ModelHint = { provider: "anthropic", modelId: "claude-opus-4-6" };
const ANTHROPIC_DEFAULT_RATIO = 3.5;

function calibrateOnce(chars: number, promptTokens: number): void {
  DEFAULT_TOKEN_COUNTER.calibrate(
    promptTokens,
    [{ role: "user", content: "a".repeat(chars) }],
    HINT,
  );
}

function homeForTest(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jazz-calib-test-"));
}

beforeEach(() => {
  DEFAULT_TOKEN_COUNTER.reset();
});

test("hydrate with no file leaves the defaults untouched", async () => {
  const original = process.env["JAZZ_HOME"];
  process.env["JAZZ_HOME"] = homeForTest();
  try {
    await Effect.runPromise(hydrateTokenCalibration());
    expect(DEFAULT_TOKEN_COUNTER.getRatio(HINT)).toBe(ANTHROPIC_DEFAULT_RATIO);
  } finally {
    if (original === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = original;
  }
});

test("save writes the learned state; a fresh hydrate restores it (resume)", async () => {
  const original = process.env["JAZZ_HOME"];
  const home = homeForTest();
  process.env["JAZZ_HOME"] = home;
  try {
    // Run 1: learn a ratio that differs from the family default.
    calibrateOnce(700, 175); // ratio 700/175 = 4.0, well off 3.5
    await Effect.runPromise(saveTokenCalibration().pipe(Effect.ignore));

    const file = path.join(home, "token-calibration.json");
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
      schemaVersion: number;
      models: Array<{ model: string; ratio: number; overhead: number }>;
    };
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.models).toHaveLength(1);
    expect(onDisk.models[0]?.model).toBe("anthropic::claude-opus-4-6");
    expect(onDisk.models[0]?.ratio).toBeCloseTo(4.0, 5);

    // The resumed "process": same home, counter wiped to defaults.
    DEFAULT_TOKEN_COUNTER.reset();
    expect(DEFAULT_TOKEN_COUNTER.getRatio(HINT)).toBe(ANTHROPIC_DEFAULT_RATIO);

    await Effect.runPromise(hydrateTokenCalibration());
    expect(DEFAULT_TOKEN_COUNTER.getRatio(HINT)).toBeCloseTo(4.0, 5);

    // The hydrated value changes real estimates: 700 chars at 4.0, not 3.5.
    expect(DEFAULT_TOKEN_COUNTER.countText("a".repeat(700), HINT)).toBe(175);
  } finally {
    if (original === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("overhead is persisted and restored", async () => {
  const original = process.env["JAZZ_HOME"];
  const home = homeForTest();
  process.env["JAZZ_HOME"] = home;
  try {
    const content = "a".repeat(400);
    const exactMessageTokens = DEFAULT_TOKEN_COUNTER.countText(content, HINT);
    // Any non-zero gap teaches an overhead; the exact value also depends on
    // the ratio clamp, so capture it instead of hard-coding it.
    DEFAULT_TOKEN_COUNTER.calibrate(exactMessageTokens + 12_000, [{ role: "user", content }], HINT);
    const learnedOverhead = DEFAULT_TOKEN_COUNTER.overheadFor(HINT);
    expect(learnedOverhead).toBeGreaterThan(0);

    await Effect.runPromise(saveTokenCalibration().pipe(Effect.ignore));
    DEFAULT_TOKEN_COUNTER.reset();
    await Effect.runPromise(hydrateTokenCalibration());

    expect(DEFAULT_TOKEN_COUNTER.overheadFor(HINT)).toBe(learnedOverhead);
  } finally {
    if (original === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("save with nothing learned does not create or clobber the file", async () => {
  const original = process.env["JAZZ_HOME"];
  const home = homeForTest();
  process.env["JAZZ_HOME"] = home;
  try {
    await Effect.runPromise(saveTokenCalibration().pipe(Effect.ignore));
    expect(fs.existsSync(path.join(home, "token-calibration.json"))).toBe(false);
  } finally {
    if (original === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a corrupt file quarantines and falls back to defaults without throwing", async () => {
  const original = process.env["JAZZ_HOME"];
  const home = homeForTest();
  process.env["JAZZ_HOME"] = home;
  try {
    fs.writeFileSync(
      path.join(home, "token-calibration.json"),
      JSON.stringify({ schemaVersion: 1, models: [{ model: "x", ratio: "not-a-number" }] }),
    );
    // Must not throw: corruption degrades to the defaults, and the bad file
    // is quarantined (moved aside) rather than re-read on every run.
    await Effect.runPromise(hydrateTokenCalibration());
    expect(DEFAULT_TOKEN_COUNTER.getRatio(HINT)).toBe(ANTHROPIC_DEFAULT_RATIO);
    expect(fs.existsSync(path.join(home, "token-calibration.json"))).toBe(false);
  } finally {
    if (original === undefined) delete process.env["JAZZ_HOME"];
    else process.env["JAZZ_HOME"] = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("hydrate skips out-of-range and tokenizer-backed entries", () => {
  const counter = new TokenCounter();
  counter.hydrate([
    { model: "anthropic::claude-opus-4-6", ratio: 4.2, overhead: 100 },
    { model: "openai::gpt-4o", ratio: 4.0, overhead: 100 }, // tokenizer-backed: dead weight
    { model: "gemini::gemini-2.5-pro", ratio: 1.0, overhead: 100 }, // below RATIO_MIN
    { model: "mistral::mistral-large", ratio: Number.NaN, overhead: 100 }, // corrupt
  ]);
  expect(counter.getRatio({ provider: "anthropic", modelId: "claude-opus-4-6" })).toBeCloseTo(
    4.2,
    5,
  );
  expect(counter.getRatio({ provider: "openai", modelId: "gpt-4o" })).toBe(4.0); // family default
  expect(counter.getRatio({ provider: "gemini", modelId: "gemini-2.5-pro" })).toBe(4.0); // family default
  expect(counter.getRatio({ provider: "mistral", modelId: "mistral-large" })).toBe(3.8); // family default
});

test("snapshot round-trips the learned values", () => {
  const counter = new TokenCounter();
  counter.calibrate(175, [{ role: "user", content: "a".repeat(700) }], HINT);
  const snapshot = counter.calibratedSnapshot();
  expect(snapshot).toHaveLength(1);
  expect(snapshot[0]?.model).toBe("anthropic::claude-opus-4-6");
  expect(snapshot[0]?.ratio).toBeCloseTo(4.0, 5);
});

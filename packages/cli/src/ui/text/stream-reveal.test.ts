import { describe, expect, it } from "bun:test";
import {
  DRAIN_MS,
  flushReveal,
  initialReveal,
  isRevealing,
  MAX_LAG_MS,
  receiveTarget,
  revealedText,
  safeCut,
  stepReveal,
  type RevealState,
} from "./stream-reveal";

const FRAME_MS = 33;

function runFrames(start: RevealState, fromMs: number, frames: number): RevealState[] {
  const states: RevealState[] = [];
  let state = start;
  for (let frame = 1; frame <= frames; frame += 1) {
    state = stepReveal(state, PROSE, fromMs + frame * FRAME_MS);
    states.push(state);
  }
  return states;
}

const PROSE =
  "Jazz is an agent harness that lets you configure an AI agent once and run it across different surfaces, from a terminal to a chat bot.";

describe("stream reveal", () => {
  it("turns one burst into a flow of several frames instead of one jump", () => {
    const state = receiveTarget(initialReveal(0), PROSE.length, 0);
    const frames = runFrames(state, 0, 30);
    const lengths = frames.map((frame) => frame.shown);
    const firstFull = lengths.findIndex((length) => length === PROSE.length);
    expect(firstFull).toBeGreaterThan(3);
    for (let index = 1; index < lengths.length; index += 1) {
      expect(lengths[index]).toBeGreaterThanOrEqual(lengths[index - 1] ?? 0);
    }
  });

  it("never holds a character back longer than the lag bound", () => {
    const state = receiveTarget(initialReveal(0), 20_000, 0);
    const late = stepReveal(
      stepReveal(state, "x".repeat(20_000), FRAME_MS),
      "x".repeat(20_000),
      MAX_LAG_MS,
    );
    expect(late.shown).toBe(20_000);
  });

  it("follows a steady stream about one time constant behind", () => {
    let state = initialReveal(0);
    let now = 0;
    let target = "";
    const word = "word ";
    for (let frame = 0; frame < 120; frame += 1) {
      now += FRAME_MS;
      target += word;
      state = receiveTarget(state, target.length, now);
      state = stepReveal(state, target, now);
    }
    const backlog = target.length - state.shown;
    const arrivalPerMs = word.length / FRAME_MS;
    expect(backlog / arrivalPerMs).toBeLessThanOrEqual(DRAIN_MS * 1.5);
    expect(backlog).toBeGreaterThan(0);
  });

  it("stops at the end of a word, never inside one", () => {
    const state = receiveTarget(initialReveal(0), PROSE.length, 0);
    for (const frame of runFrames(state, 0, 12)) {
      const text = revealedText(frame, PROSE);
      if (frame.shown > 0 && frame.shown < PROSE.length) {
        const boundary = `${PROSE.charAt(frame.shown - 1)}${PROSE.charAt(frame.shown)}`;
        expect(boundary).toMatch(/\s/);
      }
      expect(text.length).toBe(frame.shown);
    }
  });

  it("never cuts inside an escape sequence or a surrogate pair", () => {
    const link = "see \u001b]8;;https://example.com\u0007the guide\u001b]8;;\u0007 now";
    for (let cut = 0; cut <= link.length; cut += 1) {
      const safe = safeCut(link, cut);
      const prefix = link.slice(0, safe);
      const opens = prefix.split("\u001b").length - 1;
      const closes = prefix.split("\u0007").length - 1;
      expect(opens).toBe(closes);
    }
    const emoji = "ok 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀";
    for (let cut = 0; cut <= emoji.length; cut += 1) {
      const code = emoji.charCodeAt(safeCut(emoji, cut) - 1);
      expect(code >= 0xd800 && code <= 0xdbff).toBe(false);
    }
  });

  it("starts over for a new turn and flushes on demand", () => {
    let state = receiveTarget(initialReveal(0), PROSE.length, 0);
    state = stepReveal(state, PROSE, FRAME_MS);
    expect(isRevealing(state)).toBe(true);
    const flushed = flushReveal(state, FRAME_MS * 2);
    expect(revealedText(flushed, PROSE)).toBe(PROSE);
    expect(isRevealing(flushed)).toBe(false);

    const next = receiveTarget(initialReveal(FRAME_MS * 3), "A new answer".length, FRAME_MS * 3);
    expect(next.shown).toBe(0);
    expect(receiveTarget(next, 0, FRAME_MS * 4).shown).toBe(0);
  });

  it("does not count idle time as reveal time when a paused stream resumes", () => {
    let state = receiveTarget(initialReveal(0), "Hello ".length, 0);
    state = stepReveal(state, "Hello ", 2_000);
    expect(isRevealing(state)).toBe(false);
    state = receiveTarget(state, `Hello ${PROSE}`.length, 10_000);
    state = stepReveal(state, `Hello ${PROSE}`, 10_000 + FRAME_MS);
    expect(state.shown).toBeLessThan(`Hello ${PROSE}`.length);
  });
});

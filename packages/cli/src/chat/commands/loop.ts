/**
 * @fileoverview The chat `/loop` command: start a loop for this chat's agent, list this chat's
 * loops, answer what one waits on, and pause, resume, or cancel one.
 *
 * Loops always run in the daemon, never in the chat: starting one asks what it may do without
 * asking, since nobody watches its runs.
 */

import type { RunAnswer } from "@jazz/adapters/daemon/resume-owned-run";
import {
  answerLoop,
  controlLoop,
  getOwnedLoop,
  listOwnedLoops,
  loopsWaitingOnUser,
  startLoop,
} from "@jazz/adapters/loops/loop-actions";
import { makeFileGoalStoreLayer } from "@jazz/adapters/storage/goal-store";
import { makeFileLoopStoreLayer } from "@jazz/adapters/storage/loop-store";
import { makeFileRunStoreLayer } from "@jazz/adapters/storage/run-store";
import { parseLoopSchedule, type LoopControl } from "@jazz/core/agent/loop/loop-lifecycle";
import { FileSystemContextServiceTag } from "@jazz/core/interfaces/fs";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import type { ApprovalPolicyLevel } from "@jazz/core/types/tools";
import { Effect } from "effect";
import { describeDaemonStart, ensureDaemonRunning } from "@/cli/commands/daemon";
import { describeLoopNow } from "@/cli/loops/describe-loop";
import { builtinFormLines } from "./constants";
import type { CommandContext } from "./types";

/** Fields a cron expression takes, read after `/loop cron`. */
const CRON_FIELDS = 5;

type GrantChoice = ApprovalPolicyLevel | "cancel";

const GRANT_CHOICES: readonly { name: string; value: GrantChoice }[] = [
  { name: "Reading and low-risk changes; anything riskier waits for me", value: "low-risk" },
  { name: "Everything, including commands flagged high-risk", value: "high-risk" },
  { name: "Reading only; any change waits for me", value: "read-only" },
  { name: "Don't start it", value: "cancel" },
];

const loopLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(makeFileLoopStoreLayer()),
    Effect.provide(makeFileRunStoreLayer()),
    Effect.provide(makeFileGoalStoreLayer()),
  );

/**
 * The schedule and prompt in `/loop` arguments: `10m check it`, `every 10m check it`, or
 * `cron 0 9 * * mon-fri check it`.
 */
export function splitLoopArguments(
  args: readonly string[],
): { readonly schedule: string; readonly prompt: string } | undefined {
  const [first, ...rest] = args;
  if (first === undefined) {
    return undefined;
  }
  if (first.toLowerCase() === "cron") {
    return rest.length > CRON_FIELDS
      ? {
          schedule: rest.slice(0, CRON_FIELDS).join(" "),
          prompt: rest.slice(CRON_FIELDS).join(" ").trim(),
        }
      : undefined;
  }
  if (first.toLowerCase() === "every") {
    const [interval, ...prompt] = rest;
    return interval !== undefined && prompt.length > 0
      ? { schedule: interval, prompt: prompt.join(" ").trim() }
      : undefined;
  }
  return rest.length > 0 ? { schedule: first, prompt: rest.join(" ").trim() } : undefined;
}

function startHere(context: CommandContext, args: readonly string[]) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const parts = splitLoopArguments(args);
    if (parts === undefined || parts.prompt.length === 0) {
      yield* terminal.warn(
        "Usage: /loop <every> <prompt>, like /loop 10m check whether the deploy finished",
      );
      return;
    }
    const schedule = parseLoopSchedule(
      parts.schedule,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    if (!schedule.ok) {
      yield* terminal.warn(schedule.reason);
      return;
    }
    const grant = yield* terminal.select<GrantChoice>(
      "Its runs happen in the background. What may they do without asking?",
      { choices: GRANT_CHOICES, default: "low-risk" },
    );
    if (grant === undefined || grant === "cancel") {
      yield* terminal.info("Loop not started.");
      return;
    }
    const fileSystemContext = yield* FileSystemContextServiceTag;
    const workingDirectory = yield* fileSystemContext.getCwd({
      agentId: context.agent.id,
      conversationId: context.conversationId,
    });
    const outcome = yield* startLoop({
      agentId: context.agent.id,
      prompt: parts.prompt,
      schedule: schedule.schedule,
      workingDirectory,
      sourceConversationId: context.conversationId,
      approvalPolicy: grant,
    });
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return;
    }
    yield* terminal.log(yield* describeLoopNow(outcome.loop, "chat"));
    yield* terminal.success(
      describeDaemonStart(`Loop ${outcome.loop.name}`, yield* ensureDaemonRunning()),
    );
  });
}

function withLoop(handle: string | undefined, usage: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    if (handle === undefined) {
      yield* terminal.warn(`Usage: ${usage}`);
      return undefined;
    }
    const loop = yield* getOwnedLoop(handle);
    if (loop === undefined) {
      yield* terminal.warn(`No loop "${handle}". /loop list shows this conversation's loops.`);
    }
    return loop;
  });
}

function answerHere(handle: string | undefined, answer: RunAnswer, usage: string) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const loop = yield* withLoop(handle, usage);
    if (loop === undefined) {
      return;
    }
    const answered = yield* answerLoop(loop.loopId, answer);
    yield* answered.kind === "refused"
      ? terminal.warn(answered.reason)
      : terminal.log(yield* describeLoopNow(answered.loop, "chat"));
  });
}

function controlHere(control: LoopControl, handle: string | undefined) {
  return Effect.gen(function* () {
    const terminal = yield* TerminalServiceTag;
    const loop = yield* withLoop(handle, `/loop ${control} <loop>`);
    if (loop === undefined) {
      return;
    }
    const outcome = yield* controlLoop(loop.loopId, control);
    if (outcome.kind === "refused") {
      yield* terminal.warn(outcome.reason);
      return;
    }
    yield* control === "resume"
      ? terminal.success(
          describeDaemonStart(`Loop ${outcome.loop.name}`, yield* ensureDaemonRunning()),
        )
      : terminal.success(`Loop ${outcome.loop.name}: ${outcome.loop.state.kind}.`);
    if (outcome.note !== undefined) {
      yield* terminal.info(outcome.note);
    }
  });
}

export function handleLoopCommand(context: CommandContext, args: readonly string[]) {
  const [command, ...rest] = args;
  const [handle] = rest;
  const note = rest.slice(1).join(" ").trim();
  const done = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
    loopLayers(effect).pipe(Effect.as({ shouldContinue: true }));

  switch (command?.toLowerCase()) {
    case undefined:
    case "help":
      return done(
        Effect.flatMap(TerminalServiceTag, (terminal) =>
          Effect.forEach(builtinFormLines("loop"), (line) => terminal.log(line)),
        ),
      );
    case "list":
      return done(
        Effect.gen(function* () {
          const terminal = yield* TerminalServiceTag;
          const loops = yield* listOwnedLoops({ sourceConversationId: context.conversationId });
          if (loops.length === 0) {
            yield* terminal.info(
              "No loops in this conversation. Start one with /loop 10m <prompt>.",
            );
          }
          for (const loop of loops) {
            yield* terminal.log(yield* describeLoopNow(loop, "chat"));
          }
        }),
      );
    case "approve":
      return done(answerHere(handle, { kind: "approve" }, "/loop approve <loop>"));
    case "reject":
      return done(
        answerHere(
          handle,
          { kind: "reject", ...(note.length > 0 ? { note } : {}) },
          "/loop reject <loop> [why]",
        ),
      );
    case "answer":
      return note.length === 0
        ? done(
            Effect.flatMap(TerminalServiceTag, (terminal) =>
              terminal.warn("Usage: /loop answer <loop> <your answer>"),
            ),
          )
        : done(
            answerHere(
              handle,
              { kind: "answer", response: note },
              "/loop answer <loop> <your answer>",
            ),
          );
    case "pause":
    case "resume":
    case "cancel":
      return done(controlHere(command.toLowerCase() as LoopControl, handle));
  }
  return done(startHere(context, args));
}

/** On opening a conversation, show its loops that wait on the user and how to answer them. */
export function announceWaitingLoops(conversationId: string) {
  return loopLayers(
    Effect.gen(function* () {
      const terminal = yield* TerminalServiceTag;
      const waiting = yield* loopsWaitingOnUser({ sourceConversationId: conversationId });
      for (const loop of waiting) {
        yield* terminal.log(yield* describeLoopNow(loop, "chat"));
      }
    }),
  );
}

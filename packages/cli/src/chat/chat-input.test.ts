import { PassThrough } from "node:stream";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { PlainTerminalService } from "@/cli/terminal";
import { classifyChatInput, type ChatInput } from "./chat-input";

describe("classifyChatInput", () => {
  test("undefined from a non-interactive terminal is the end of input", () => {
    expect(classifyChatInput(undefined, false)).toEqual({ kind: "end-of-input" });
  });

  test("undefined from an interactive terminal is a blank line", () => {
    expect(classifyChatInput(undefined, true)).toEqual({ kind: "blank" });
  });

  test("exit words end the chat on any terminal", () => {
    for (const word of ["/exit", "exit", " QUIT "]) {
      expect(classifyChatInput(word, true)).toEqual({ kind: "exit" });
      expect(classifyChatInput(word, false)).toEqual({ kind: "exit" });
    }
  });

  test("whitespace is blank and anything else is a message", () => {
    expect(classifyChatInput("   ", false)).toEqual({ kind: "blank" });
    expect(classifyChatInput("hello", false)).toEqual({ kind: "message", text: "hello" });
  });
});

/**
 * Regression for the non-TTY busy loop: `jazz agent chat` with piped or empty
 * stdin printed a tip and prompted again as fast as the CPU allowed (705k lines
 * and 7.7 GB RSS in 16 seconds). This drives the chat loop's input step, the
 * plain terminal's `ask` followed by `classifyChatInput`, the way the loop does,
 * and caps the prompts it may issue.
 */
describe("chat input on a non-interactive terminal", () => {
  const PROMPT_CAP = 20;

  async function drainChatInput(stdin: string): Promise<{ inputs: ChatInput[]; prompts: number }> {
    const input = new PassThrough();
    input.end(stdin);
    const terminal = new PlainTerminalService({
      input,
      output: { write: () => true },
      errorOutput: { write: () => true },
    });
    const inputs: ChatInput[] = [];
    let prompts = 0;
    while (prompts < PROMPT_CAP) {
      prompts += 1;
      const answer = await Effect.runPromise(terminal.ask("You:", { commandSuggestions: true }));
      const classified = classifyChatInput(answer, terminal.isInteractive);
      inputs.push(classified);
      if (classified.kind === "end-of-input" || classified.kind === "exit") {
        break;
      }
    }
    return { inputs, prompts };
  }

  test("empty stdin ends the session after one prompt", async () => {
    const { inputs, prompts } = await drainChatInput("");

    expect(prompts).toBe(1);
    expect(inputs).toEqual([{ kind: "end-of-input" }]);
  });

  test("piped lines are read in order, then the session ends at EOF", async () => {
    const { inputs, prompts } = await drainChatInput("hello\n\nhow are you?\n");

    expect(prompts).toBe(4);
    expect(inputs).toEqual([
      { kind: "message", text: "hello" },
      { kind: "blank" },
      { kind: "message", text: "how are you?" },
      { kind: "end-of-input" },
    ]);
  });
});

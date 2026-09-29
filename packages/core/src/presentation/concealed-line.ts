/**
 * Reading one secret line from a terminal with nothing echoed but a bullet per character.
 *
 * The keystrokes are folded by a pure reducer, so the masking and the cancel path are testable
 * without a terminal: Enter submits, Esc or Ctrl-C cancels, Backspace deletes the last
 * character, Ctrl-U clears, and arrow and function keys are ignored.
 */

/** What one concealed line looks like after the keys so far. */
export interface ConcealedLine {
  readonly value: string;
  readonly done?: "submitted" | "cancelled";
}

/** The character drawn for every character of a concealed value. */
export const CONCEALED_CHARACTER = "•";

const ENTER = "\r";
const NEWLINE = "\n";
const ESCAPE = "\u001b";
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const CTRL_U = "\u0015";
const BACKSPACE = "\u007f";
const CTRL_H = "\b";
const FIRST_PRINTABLE_CODE = 0x20;
/** An escape sequence ends on its first character from `@` to `~`. */
const SEQUENCE_FINAL_FIRST_CODE = 0x40;
const SEQUENCE_FINAL_LAST_CODE = 0x7e;

/** Bullets standing for `value`, one per character. */
export function concealValue(value: string): string {
  return CONCEALED_CHARACTER.repeat([...value].length);
}

/**
 * The length of the escape sequence at the start of `text`, a lone Esc being zero: `ESC [ ... final`
 * or `ESC O final`, as arrow, Home, End and function keys send.
 */
function escapeSequenceLength(text: string): number {
  const introducer = text[1];
  if (introducer !== "[" && introducer !== "O") {
    return 0;
  }
  for (let index = 2; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= SEQUENCE_FINAL_FIRST_CODE && code <= SEQUENCE_FINAL_LAST_CODE) {
      return index + 1;
    }
  }
  return text.length;
}

/** `line` after the keys in `chunk`. Keys after a submit or cancel are ignored. */
export function applyConcealedKeys(line: ConcealedLine, chunk: string): ConcealedLine {
  let value = line.value;
  let index = 0;
  while (index < chunk.length) {
    if (line.done !== undefined) {
      return line;
    }
    const key = chunk[index] ?? "";
    if (key === ENTER || key === NEWLINE) {
      return { value, done: "submitted" };
    }
    if (key === CTRL_C || key === CTRL_D) {
      return { value: "", done: "cancelled" };
    }
    if (key === ESCAPE) {
      const sequence = escapeSequenceLength(chunk.slice(index));
      if (sequence === 0) {
        return { value: "", done: "cancelled" };
      }
      index += sequence;
      continue;
    }
    if (key === BACKSPACE || key === CTRL_H) {
      value = [...value].slice(0, -1).join("");
    } else if (key === CTRL_U) {
      value = "";
    } else if (key.charCodeAt(0) >= FIRST_PRINTABLE_CODE) {
      value += key;
    }
    index += 1;
  }
  return { value };
}

/** The terminal a concealed line is read from and drawn on. */
export interface ConcealedLineTerminal {
  readonly input: NodeJS.ReadStream;
  readonly output: NodeJS.WritableStream;
}

/**
 * Read one line with every character drawn as a bullet. Resolves the value, or undefined when
 * the person cancels. On a stream that is not a terminal (a password manager piping in), the
 * first line is read as it is, with nothing echoed.
 */
export function readConcealedLine(
  prompt: string,
  terminal: ConcealedLineTerminal = { input: process.stdin, output: process.stderr },
): Promise<string | undefined> {
  const { input, output } = terminal;
  return new Promise((resolve) => {
    const isTerminal = input.isTTY === true && typeof input.setRawMode === "function";
    const wasRaw = isTerminal ? input.isRaw : false;
    let line: ConcealedLine = { value: "" };
    output.write(prompt);
    if (isTerminal) {
      input.setRawMode(true);
    }
    input.setEncoding("utf-8");

    const finish = (value: string | undefined) => {
      input.off("data", onData);
      input.off("end", onEnd);
      if (isTerminal) {
        input.setRawMode(wasRaw);
      }
      input.pause();
      output.write("\n");
      resolve(value);
    };
    const onEnd = () => {
      finish(line.value.length > 0 ? line.value : undefined);
    };
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const shownBefore = [...line.value].length;
      line = applyConcealedKeys(line, text);
      if (isTerminal) {
        const shownAfter = [...line.value].length;
        if (shownAfter > shownBefore) {
          output.write(CONCEALED_CHARACTER.repeat(shownAfter - shownBefore));
        } else if (shownAfter < shownBefore) {
          output.write("\b \b".repeat(shownBefore - shownAfter));
        }
      }
      if (line.done === "submitted") {
        finish(line.value);
      } else if (line.done === "cancelled") {
        finish(undefined);
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });
}

/**
 * A POSIX-shell lexer for approval decisions.
 *
 * `execute_command` hands its string to a real shell, so any decision made
 * about that string (the "always approve" allowlist, the deterministic risk
 * floor in front of the command-risk classifier) has to read it the way the
 * shell will. This module splits a command line into simple commands the way
 * bash does: quotes, backslash escapes, control operators, redirections,
 * leading `NAME=value` assignments, and every form of expansion that can run
 * code.
 *
 * It does not evaluate anything. When it meets a construct that runs code
 * (`$(...)`, backticks, `$((...))`, `$[...]`, `<(...)`, `>(...)`) it records a
 * `substitution` hazard and stops, because nothing after that point can be
 * judged statically. Unterminated quotes record `malformed` and stop.
 *
 * Use `parseShellCommandLine(command)` and read:
 * - `commands`: the simple commands in order, each with its assignments,
 *   words and redirections.
 * - `separators`: the control operator that precedes each command after the
 *   first (`separators[i]` sits between `commands[i]` and `commands[i + 1]`).
 * - `hazards`: every shell feature seen that makes the line more than one
 *   plain command.
 */

export type ShellHazard =
  /** `;`, `&`, `&&`, `||`, `|`, `|&`, `;;`, `;&` or an unquoted newline. */
  | "control-operator"
  /** `$(...)`, backticks, `$((...))`, `$[...]`, `<(...)`, `>(...)`, or `${...}` that can run code. */
  | "substitution"
  /** Any `<`, `>` form, here-documents and here-strings included. */
  | "redirection"
  /** A leading `NAME=value` word that changes the command's environment. */
  | "assignment"
  /** `${...}` parameter expansion. */
  | "parameter-expansion"
  /** `(` or `)` outside quotes. */
  | "grouping"
  /** An unquoted `#` that starts a comment. */
  | "comment"
  /** `$'...'` ANSI-C quoting, whose escapes this lexer does not decode. */
  | "ansi-c-quote"
  /** An unterminated quote or expansion. */
  | "malformed";

export type ShellControlOperator = "&&" | "||" | ";" | ";;" | ";&" | "|" | "|&" | "&" | "\n";

export interface ShellWord {
  /** The word after quote removal, with `$NAME` expansions left as written. */
  readonly text: string;
  /** Whether the word contains a `$` expansion outside single quotes. */
  readonly expands: boolean;
}

export interface ShellRedirection {
  /** The operator as written, including a leading file-descriptor number (`2>`, `&>`). */
  readonly operator: string;
  /** The target word, or `undefined` when the line ended first. */
  readonly target: ShellWord | undefined;
}

export interface ShellSimpleCommand {
  readonly assignments: readonly ShellWord[];
  readonly words: readonly ShellWord[];
  readonly redirections: readonly ShellRedirection[];
}

export interface ShellCommandLine {
  readonly commands: readonly ShellSimpleCommand[];
  readonly separators: readonly ShellControlOperator[];
  readonly hazards: ReadonlySet<ShellHazard>;
}

const CONTROL_OPERATORS: readonly ShellControlOperator[] = [
  "&&",
  "||",
  ";;",
  ";&",
  "|&",
  "|",
  "&",
  ";",
];

const REDIRECTION_OPERATORS: readonly string[] = [
  "&>>",
  "<<<",
  "<<-",
  "&>",
  ">>",
  "<<",
  "<>",
  ">|",
  ">&",
  "<&",
  ">",
  "<",
];

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const NAME_START_PATTERN = /[A-Za-z_]/;
const NAME_PATTERN = /[A-Za-z0-9_]/;
const SPECIAL_PARAMETER_PATTERN = /[0-9@*#?$!-]/;
const FILE_DESCRIPTOR_PATTERN = /^[0-9]+$/;
/** Parameter-expansion operators that evaluate code: `${x@P}` prompt expansion and array subscripts. */
const CODE_RUNNING_EXPANSION_PATTERN = /[@[`(]/;

class StopLexing extends Error {}

interface WordBuilder {
  text: string;
  raw: string;
  expands: boolean;
  started: boolean;
}

function emptyWord(): WordBuilder {
  return { text: "", raw: "", expands: false, started: false };
}

/**
 * Lex a shell command line into simple commands. Never throws: anything it
 * cannot model is reported through `hazards`.
 */
export function parseShellCommandLine(command: string): ShellCommandLine {
  const hazards = new Set<ShellHazard>();
  const commands: ShellSimpleCommand[] = [];
  const separators: ShellControlOperator[] = [];

  let assignments: ShellWord[] = [];
  let words: ShellWord[] = [];
  let redirections: ShellRedirection[] = [];
  let pendingRedirection: string | undefined;
  let word = emptyWord();
  let index = 0;

  const finishWord = (): void => {
    if (!word.started) {
      return;
    }
    const finished: ShellWord = { text: word.text, expands: word.expands };
    if (pendingRedirection !== undefined) {
      redirections.push({ operator: pendingRedirection, target: finished });
      pendingRedirection = undefined;
    } else if (words.length === 0 && ASSIGNMENT_PATTERN.test(word.raw)) {
      assignments.push(finished);
      hazards.add("assignment");
    } else {
      words.push(finished);
    }
    word = emptyWord();
  };

  const finishCommand = (): void => {
    finishWord();
    if (pendingRedirection !== undefined) {
      redirections.push({ operator: pendingRedirection, target: undefined });
      pendingRedirection = undefined;
    }
    if (assignments.length > 0 || words.length > 0 || redirections.length > 0) {
      commands.push({ assignments, words, redirections });
    }
    assignments = [];
    words = [];
    redirections = [];
  };

  const append = (text: string, raw: string = text): void => {
    word.text += text;
    word.raw += raw;
    word.started = true;
  };

  const stop = (hazard: ShellHazard): never => {
    hazards.add(hazard);
    throw new StopLexing();
  };

  /** Read a `$` expansion starting at `index` (which points at `$`). */
  const readDollar = (insideDoubleQuotes: boolean): void => {
    const next = command[index + 1];
    if (next === "(" || next === "[") {
      stop("substitution");
    }
    if (next === "{") {
      const close = command.indexOf("}", index + 2);
      if (close === -1) {
        stop("malformed");
      }
      const body = command.slice(index + 2, close);
      hazards.add("parameter-expansion");
      if (CODE_RUNNING_EXPANSION_PATTERN.test(body) || body.includes("$")) {
        stop("substitution");
      }
      append(command.slice(index, close + 1));
      word.expands = true;
      index = close + 1;
      return;
    }
    if (!insideDoubleQuotes && next === "'") {
      const close = findAnsiCQuoteEnd(command, index + 2);
      if (close === -1) {
        stop("malformed");
      }
      hazards.add("ansi-c-quote");
      append(command.slice(index + 2, close), command.slice(index, close + 1));
      index = close + 1;
      return;
    }
    if (!insideDoubleQuotes && next === '"') {
      index += 1;
      return;
    }
    if (next !== undefined && NAME_START_PATTERN.test(next)) {
      let end = index + 2;
      while (end < command.length && NAME_PATTERN.test(command[end] ?? "")) {
        end += 1;
      }
      append(command.slice(index, end));
      word.expands = true;
      index = end;
      return;
    }
    if (next !== undefined && SPECIAL_PARAMETER_PATTERN.test(next)) {
      append(command.slice(index, index + 2));
      word.expands = true;
      index += 2;
      return;
    }
    append("$");
    index += 1;
  };

  const readDoubleQuoted = (): void => {
    index += 1;
    word.started = true;
    word.raw += '"';
    while (index < command.length) {
      const character = command[index];
      if (character === '"') {
        word.raw += '"';
        index += 1;
        return;
      }
      if (character === "`") {
        stop("substitution");
      }
      if (character === "\\") {
        const escaped = command[index + 1];
        if (escaped === "\n") {
          index += 2;
          continue;
        }
        if (escaped === "$" || escaped === "`" || escaped === '"' || escaped === "\\") {
          append(escaped, `\\${escaped}`);
          index += 2;
          continue;
        }
        append("\\");
        index += 1;
        continue;
      }
      if (character === "$") {
        readDollar(true);
        continue;
      }
      append(character ?? "");
      index += 1;
    }
    stop("malformed");
  };

  const matchAt = (candidates: readonly string[]): string | undefined =>
    candidates.find((candidate) => command.startsWith(candidate, index));

  try {
    while (index < command.length) {
      const character = command[index] ?? "";

      if (character === " " || character === "\t") {
        finishWord();
        index += 1;
        continue;
      }

      if (character === "\\") {
        const escaped = command[index + 1];
        if (escaped === "\n") {
          index += 2;
          continue;
        }
        if (escaped === undefined) {
          append("\\");
          index += 1;
          continue;
        }
        append(escaped, `\\${escaped}`);
        index += 2;
        continue;
      }

      if (character === "'") {
        const close = command.indexOf("'", index + 1);
        if (close === -1) {
          stop("malformed");
        }
        append(command.slice(index + 1, close), command.slice(index, close + 1));
        index = close + 1;
        continue;
      }

      if (character === '"') {
        readDoubleQuoted();
        continue;
      }

      if (character === "`") {
        stop("substitution");
      }

      if (character === "$") {
        readDollar(false);
        continue;
      }

      if (character === "#" && !word.started) {
        hazards.add("comment");
        break;
      }

      if ((character === "<" || character === ">") && command[index + 1] === "(") {
        stop("substitution");
      }

      const redirection = matchAt(REDIRECTION_OPERATORS);
      if (redirection !== undefined) {
        let operator = redirection;
        if (word.started && FILE_DESCRIPTOR_PATTERN.test(word.raw)) {
          operator = `${word.raw}${redirection}`;
          word = emptyWord();
        } else {
          finishWord();
        }
        if (pendingRedirection !== undefined) {
          redirections.push({ operator: pendingRedirection, target: undefined });
        }
        hazards.add("redirection");
        pendingRedirection = operator;
        index += redirection.length;
        continue;
      }

      if (character === "\n" || character === "\r") {
        finishCommand();
        separators.push("\n");
        hazards.add("control-operator");
        index += 1;
        continue;
      }

      const control = CONTROL_OPERATORS.find((candidate) => command.startsWith(candidate, index));
      if (control !== undefined) {
        finishCommand();
        separators.push(control);
        hazards.add("control-operator");
        index += control.length;
        continue;
      }

      if (character === "(" || character === ")") {
        finishCommand();
        hazards.add("grouping");
        index += 1;
        continue;
      }

      append(character);
      index += 1;
    }
  } catch (error) {
    if (!(error instanceof StopLexing)) {
      throw error;
    }
  }

  finishCommand();
  return { commands, separators, hazards };
}

/** Index of the `'` closing an ANSI-C quote whose body starts at `from`, honoring `\'`. */
function findAnsiCQuoteEnd(command: string, from: number): number {
  for (let index = from; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "'") {
      return index;
    }
  }
  return -1;
}

/** The last path segment of a command word: `/usr/bin/curl` is `curl`. */
export function commandBaseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

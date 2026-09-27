import { describe, expect, it } from "bun:test";
import { commandBaseName, parseShellCommandLine } from "./shell-syntax";

function wordsOf(command: string): string[][] {
  return parseShellCommandLine(command).commands.map((simpleCommand) =>
    simpleCommand.words.map((word) => word.text),
  );
}

function hazardsOf(command: string): string[] {
  return [...parseShellCommandLine(command).hazards].sort();
}

describe("parseShellCommandLine", () => {
  it("splits a plain command into words with no hazards", () => {
    expect(wordsOf("git log --oneline -n 5")).toEqual([["git", "log", "--oneline", "-n", "5"]]);
    expect(hazardsOf("git log --oneline -n 5")).toEqual([]);
  });

  it("removes quotes and backslash escapes the way the shell does", () => {
    expect(wordsOf(`'git' "sta"tus a\\ b "x\\"y" 'it''s'`)).toEqual([
      ["git", "status", "a b", 'x"y', "its"],
    ]);
  });

  it("keeps operators inside quotes as data", () => {
    expect(wordsOf(`echo "a && b" 'c | d' e\\;f`)).toEqual([["echo", "a && b", "c | d", "e;f"]]);
    expect(hazardsOf(`echo "a && b" 'c | d' e\\;f`)).toEqual([]);
  });

  it("splits on every control operator and records the separators", () => {
    const line = parseShellCommandLine("a && b || c; d | e |& f & g\nh");
    expect(line.commands.map((simpleCommand) => simpleCommand.words[0]?.text)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
    expect(line.separators).toEqual(["&&", "||", ";", "|", "|&", "&", "\n"]);
    expect(line.hazards.has("control-operator")).toBe(true);
  });

  it.each([
    ["git status $(rm x)"],
    ["git status `rm x`"],
    ['git status "$(rm x)"'],
    ['git status "`rm x`"'],
    ["git status <(rm x)"],
    ["git status >(rm x)"],
    ["echo $((1 + 2))"],
    ["echo $[1 + 2]"],
    ["echo ${x@P}"],
    ["echo ${x[$i]}"],
    ["echo ${x:-$(rm y)}"],
  ])("records substitution in %p", (command) => {
    expect(parseShellCommandLine(command).hazards.has("substitution")).toBe(true);
  });

  it("treats substitution syntax inside single quotes as text", () => {
    expect(hazardsOf("grep '$(x)' `echo`")).toContain("substitution");
    expect(hazardsOf("grep '$(x) `y`' file")).toEqual([]);
  });

  it("reads redirections with their file-descriptor prefix and target", () => {
    const [simpleCommand] = parseShellCommandLine("cmd 2>/dev/null >out &>>log 2>&1 <in").commands;
    expect(simpleCommand?.words.map((word) => word.text)).toEqual(["cmd"]);
    expect(
      simpleCommand?.redirections.map((redirection) => [
        redirection.operator,
        redirection.target?.text,
      ]),
    ).toEqual([
      ["2>", "/dev/null"],
      [">", "out"],
      ["&>>", "log"],
      ["2>&", "1"],
      ["<", "in"],
    ]);
  });

  it("does not take a digit inside a word as a file descriptor", () => {
    const [simpleCommand] = parseShellCommandLine("echo a2>out").commands;
    expect(simpleCommand?.words.map((word) => word.text)).toEqual(["echo", "a2"]);
    expect(simpleCommand?.redirections[0]?.operator).toBe(">");
  });

  it("records leading assignments apart from the command words", () => {
    const [simpleCommand] = parseShellCommandLine("PAGER=x A+=1 git log B=2").commands;
    expect(simpleCommand?.assignments.map((word) => word.text)).toEqual(["PAGER=x", "A+=1"]);
    expect(simpleCommand?.words.map((word) => word.text)).toEqual(["git", "log", "B=2"]);
    expect(hazardsOf("PAGER=x git log")).toEqual(["assignment"]);
  });

  it("does not treat a quoted name as an assignment", () => {
    expect(hazardsOf(`"PAGER"=x git log`)).toEqual([]);
  });

  it("marks words that expand parameters", () => {
    const [simpleCommand] = parseShellCommandLine("echo $HOME '$HOME' \"$1\" ${USER}").commands;
    expect(simpleCommand?.words.map((word) => word.expands)).toEqual([
      false,
      true,
      false,
      true,
      true,
    ]);
  });

  it("records comments, grouping, ANSI-C quotes and malformed input", () => {
    expect(hazardsOf("git status # && rm x")).toEqual(["comment"]);
    expect(wordsOf("git status # && rm x")).toEqual([["git", "status"]]);
    expect(hazardsOf("(git status)")).toEqual(["grouping"]);
    expect(hazardsOf("echo $'a\\x3bb'")).toEqual(["ansi-c-quote"]);
    expect(hazardsOf("echo 'open")).toEqual(["malformed"]);
    expect(hazardsOf('echo "open')).toEqual(["malformed"]);
    expect(hazardsOf("echo ${open")).toEqual(["malformed"]);
  });

  it("joins a backslash-newline continuation", () => {
    expect(wordsOf("git \\\nstatus")).toEqual([["git", "status"]]);
    expect(hazardsOf("git \\\nstatus")).toEqual([]);
  });

  it("treats a # inside a word as text", () => {
    expect(wordsOf("echo a#b")).toEqual([["echo", "a#b"]]);
  });
});

describe("commandBaseName", () => {
  it("returns the last path segment", () => {
    expect(commandBaseName("/usr/bin/curl")).toBe("curl");
    expect(commandBaseName("curl")).toBe("curl");
  });
});

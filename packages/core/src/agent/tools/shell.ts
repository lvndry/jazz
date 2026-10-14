import { spawn, type ChildProcess } from "child_process";
import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { z } from "zod";
import {
  SHELL_COMMAND_MAX_TIMEOUT_MS,
  SHELL_COMMAND_TIMEOUT_MINUTES,
} from "@/core/constants/agent";
import { FileSystemContextServiceTag, type FileSystemContextService } from "@/core/interfaces/fs";
import type { LoggerService } from "@/core/interfaces/logger";
import { LoggerServiceTag } from "@/core/interfaces/logger";
import type { KnownSecret } from "@/core/secrets/redaction";
import { redactionPlaceholder } from "@/core/secrets/secret-names";
import { secretUseNeedsPerson, userSecretNamesIn } from "@/core/secrets/user-secrets";
import type { ToolExecutionContext, ToolExecutionResult } from "@/core/types";
import { formatDuration } from "@/core/utils/duration";
import { createSanitizedEnv } from "@/core/utils/env";
import { toError } from "@/core/utils/errors";
import {
  PIPE_DRAIN_GRACE_MS,
  terminateProcessGroup,
  trackChildProcess,
} from "@/core/utils/process";
import {
  defineApprovalTool,
  makeZodValidator,
  type ApprovalToolConfig,
  type ApprovalToolPair,
} from "./base-tool";
import {
  bindCappedStdio,
  type CappedOutput,
  DEFAULT_SPAWN_OUTPUT_CAP_BYTES,
  formatCappedStream,
  formatRedactedCappedStream,
  REDACTION_LOOKAHEAD_BYTES,
} from "./capped-output";
import { buildKeyFromContext } from "./context-utils";
import { toolKnownSecrets } from "./tool-secrets";

/** An inline `mktemp` command substitution — `$(mktemp …)` or `` `mktemp …` ``. */
const MKTEMP_INLINE = /\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`/g;

/** A placeholder standing in for an inline `mktemp` so it survives whitespace splitting. */
const MKTEMP_SENTINEL = "MKTEMP_TEMPDIR_SENTINEL";

/**
 * Variable assignments whose value comes from `mktemp` (either `$(mktemp …)` or
 * a backtick form), e.g. `tmp="$(mktemp -d)"`. Global flag so `matchAll` walks
 * every assignment in a multi-line command.
 */
const MKTEMP_ASSIGNMENT = /(\w+)=["']?(?:\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`)["']?/g;

function collectMktempVars(command: string): Set<string> {
  const vars = new Set<string>();
  for (const match of command.matchAll(MKTEMP_ASSIGNMENT)) {
    const name = match[1];
    if (name) vars.add(name);
  }
  return vars;
}

/**
 * Is `token` (already normalized — quotes stripped, inline `mktemp` replaced
 * with {@link MKTEMP_SENTINEL}) a temp target: an inline `mktemp`, a
 * `$TMPDIR`/`${TMPDIR}` path, or a `$var`/`${var}` (optionally with a
 * `/subpath`) whose value was assigned from `mktemp` earlier in the command?
 */
function isTempPathToken(token: string, mktempVars: Set<string>): boolean {
  if (token === MKTEMP_SENTINEL) return true; // inline $(mktemp …) / `mktemp …`
  if (token.split("/").includes("..")) {
    return false; // `$TMPDIR/../..` climbs out of the temp dir
  }
  if (/^\$\{?TMPDIR\}?(?:\/.*)?$/.test(token)) return true; // $TMPDIR or ${TMPDIR}[/…]
  const varName = token.match(/^\$\{?(\w+)\}?(?:\/.*)?$/)?.[1]; // $var / ${var}[/…]
  return varName !== undefined && mktempVars.has(varName);
}

/**
 * True when every destructive `rm` in the command targets only temp locations
 * created via `mktemp` (directly or through a variable) or under `$TMPDIR`.
 *
 * Lets routine temp-dir cleanup — `tmp="$(mktemp -d)"; …; rm -rf "$tmp"` — pass
 * the denylist, while `rm -rf` against a real path (or a mix of temp and real
 * targets) stays blocked. Deliberately narrow: literal `/tmp/…` paths are NOT
 * exempted, matching the existing policy that treats them as dangerous.
 */
function isTempCleanupRm(command: string): boolean {
  const mktempVars = collectMktempVars(command);
  const rmInvocations = command.match(/\brm\b[^\n;&|]*/g);
  if (!rmInvocations || rmInvocations.length === 0) return false;
  return rmInvocations.every((invocation) => {
    const targets = invocation
      .slice(2) // drop the leading "rm"
      .replace(/['"]/g, "") // shell quoting can sit mid-token (e.g. "$dir"/*)
      .replace(MKTEMP_INLINE, ` ${MKTEMP_SENTINEL} `) // keep inline mktemp as one token
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0 && !token.startsWith("-"));
    return targets.length > 0 && targets.every((token) => isTempPathToken(token, mktempVars));
  });
}

/**
 * A named carve-out for a forbidden rule. When a command trips a rule, it is
 * still allowed if any of the rule's exemptions matches the command. Add new
 * entries here (and reference them from a rule's `exemptions`) to grow the set
 * of safe exceptions without special-casing the matcher.
 */
type CommandExemption = {
  /** Stable identifier, handy for logging/telemetry and tests. */
  readonly name: string;
  /** True when this exemption applies to the given command. */
  readonly matches: (command: string) => boolean;
};

/**
 * Temp-dir cleanup: an `rm` whose every target is a mktemp/$TMPDIR temp path.
 * Lets `tmp="$(mktemp -d)"; …; rm -rf "$tmp"` through without opening up
 * `rm -rf` against real paths.
 */
const TEMP_CLEANUP_EXEMPTION: CommandExemption = {
  name: "temp-cleanup",
  matches: isTempCleanupRm,
};

/**
 * A single denylist entry: the pattern that flags a command, plus a short,
 * agent-readable `reason` explaining *why* it was blocked. The reason is
 * surfaced verbatim in the tool error so the model (and user) learn the exact
 * cause — e.g. "`rm` with a recursive/force flag" — instead of a generic
 * "this command was blocked".
 */
type ForbiddenRule = {
  readonly pattern: RegExp;
  readonly reason: string;
  /**
   * Named carve-outs: if any listed exemption matches the command, this rule is
   * skipped. Lets a rule stay broad while allowing known-safe shapes (e.g. the
   * {@link TEMP_CLEANUP_EXEMPTION} for temp-dir cleanup).
   */
  readonly exemptions?: readonly CommandExemption[];
};

/**
 * Where a program name sits when the shell will run it: at the start of the line or of a
 * command after a control operator or substitution opener, after wrappers that run their
 * arguments (`env`, `nohup`, `xargs`, `timeout 5`, …), after leading `NAME=value`
 * assignments, inside a shell's `-c` string, or after `find -exec`. A path prefix
 * (`/sbin/reboot`) is allowed. Anchoring here keeps a rule from firing on the same word
 * inside an argument, such as a commit message or a grep pattern.
 */
const COMMAND_START =
  String.raw`(?:^|[\n;&|({` +
  "`" +
  String.raw`]|\$\(|\b(?:ba|z|k|da|fi)?sh\s+(?:-\w+\s+)*-\w*c\s+['"]?|-exec\s+)\s*(?:(?:env|nohup|time|exec|command|builtin|nice|xargs|then|do|else|!|timeout\s+\S+)\s+)*(?:\w+=\S*\s+)*(?:\S*\/)?`;

/** A rule pattern for `body` matched where it runs as a command; see {@link COMMAND_START}. */
function asCommand(body: string, flags = ""): RegExp {
  return new RegExp(COMMAND_START + body, flags);
}

/** The text of one simple command after its program name: stops at a control operator. */
const SAME_COMMAND = String.raw`[^\n;&|]*`;

/** A shell invoked with `-c`, ending right where its code string begins. */
const SHELL_DASH_C_BEFORE = /\b(?:ba|z|k|da|fi)?sh\s+(?:-\w+\s+)*-\w*c\s+$/;

/** Characters that start a command when the shell sees them unquoted. */
const COMMAND_START_CHARACTERS = /[\n;&|({`]/g;

/**
 * Replace command-starting characters inside quoted text with spaces, so a quoted
 * argument such as `rg 'shutdown|halt'` or `git commit -m "a; reboot"` cannot look
 * like a command to {@link COMMAND_START}. Quoted text the shell does run stays
 * intact: the code string of `sh -c '…'`, and a double-quoted string holding `$(…)`
 * or backticks. Both are processed recursively.
 */
function blankQuotedOperators(command: string): string {
  let output = "";
  let index = 0;
  while (index < command.length) {
    const character = command[index];
    if (character === "\\") {
      output += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (character !== "'" && character !== '"') {
      output += character;
      index += 1;
      continue;
    }
    const closingIndex = findClosingQuote(command, index);
    if (closingIndex === -1) {
      output += command.slice(index);
      break;
    }
    const body = command.slice(index + 1, closingIndex);
    const shellRunsBody =
      SHELL_DASH_C_BEFORE.test(output) || (character === '"' && /\$\(|`/.test(body));
    const maskedBody = shellRunsBody
      ? blankQuotedOperators(body)
      : body.replace(COMMAND_START_CHARACTERS, " ");
    output += character + maskedBody + character;
    index = closingIndex + 1;
  }
  return output;
}

/** Index of the quote closing the one at `openIndex`; double quotes honor `\"`. */
function findClosingQuote(command: string, openIndex: number): number {
  const quote = command[openIndex];
  if (quote === "'") {
    return command.indexOf("'", openIndex + 1);
  }
  for (let index = openIndex + 1; index < command.length; index += 1) {
    if (command[index] === "\\") {
      index += 1;
    } else if (command[index] === '"') {
      return index;
    }
  }
  return -1;
}

/** Shells and interpreters that execute a script read from stdin or a file argument. */
const SCRIPT_RUNNER = String.raw`(?:(?:ba|z|k|da|fi)?sh|python[\d.]*|node|bun|deno|ruby|perl)\b`;

/**
 * Commands blocked before approval is even asked.
 *
 * Every command already runs as `sh -c <command>` with the user's privileges, so this list
 * is not a sandbox and it does not try to be one: variable expansion, quote splicing, and
 * encoded payloads route around any string matcher, and the approval gate is what governs
 * arbitrary code. A rule belongs here only when it names a specific action whose damage
 * reaches past the workspace or cannot be undone, and that no approval should be trusted
 * to catch: escalating privileges, wiping disks or the home directory, running a remote
 * script, opening a reverse shell, planting persistence, or granting the agent its own
 * authority. How code is invoked (`sh -c`, `python -c`, `eval`) is never a rule, because
 * blocking it only pushes the same code into a temp file the list cannot read.
 *
 * See `shell.security.test.ts` for the regression suite and the documented bypasses.
 */
export const FORBIDDEN_COMMANDS: readonly ForbiddenRule[] = [
  // Accepting a goal grants it authority to keep working unattended; that is the user's call.
  {
    pattern: asCommand(String.raw`jazz\s+goal\s+(?:accept\b|start\b[^\n]*--yes\b)`),
    reason:
      "accepting a goal (`jazz goal accept`, `jazz goal start --yes`) is the user's decision, not an agent's",
  },
  // Starting or resuming a loop grants it authority to rerun unattended; that is the user's call.
  {
    pattern: asCommand(String.raw`jazz\s+loop\s+(?:start|resume)\b`),
    reason:
      "starting or resuming a loop (`jazz loop start`, `jazz loop resume`) is the user's decision, not an agent's",
  },
  // A parked run stopped to ask the user; an agent answering it would grant itself the step.
  {
    pattern: asCommand(String.raw`jazz\s+(?:goal|loop|runs)\s+(?:approve|answer)\b`),
    reason:
      "approving or answering a parked run (`jazz runs approve`, `jazz goal answer`, `jazz loop approve`) is the user's decision, not an agent's",
  },

  // Deletes go through the rm tool, which shows what will be removed before approval and
  // refuses / and the home directory. Only temp-path cleanup stays in the shell.
  {
    pattern: asCommand(String.raw`rm(?=\s|$)`),
    reason:
      "deleting with shell `rm` is on the blocked list; use the rm tool, which shows what will be deleted before approval (mktemp/$TMPDIR temp paths are exempt)",
    exemptions: [TEMP_CLEANUP_EXEMPTION],
  },
  {
    pattern: asCommand(String.raw`unlink\b`),
    reason: "deleting with `unlink` is on the blocked list; use the rm tool",
  },
  {
    pattern: asCommand(String.raw`find\b${SAME_COMMAND}\s-delete\b`),
    reason: "deleting with `find -delete` is on the blocked list; use the rm tool on each path",
  },

  // Privilege escalation
  {
    pattern: asCommand(String.raw`sudo\b`),
    reason: "`sudo` (privilege escalation) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`su(?:\s|$)`),
    reason: "`su` (switch user) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`doas\b`),
    reason: "`doas` (privilege escalation) is on the blocked list",
  },

  // Disk-level destruction
  {
    pattern: asCommand(String.raw`mkfs\b`),
    reason: "`mkfs` (filesystem formatting) is on the blocked list",
  },
  {
    pattern: asCommand(
      String.raw`dd\s+${SAME_COMMAND}\bof=\/dev\/(?!null\b|stdout\b|stderr\b|fd\/)`,
    ),
    reason: "`dd` writing to a device (of=/dev/...) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`shred\b`),
    reason: "`shred` (unrecoverable wipe) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`wipefs\b`),
    reason: "`wipefs` (disk erase) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`blkdiscard\b`),
    reason: "`blkdiscard` (disk erase) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`hdparm\b${SAME_COMMAND}--security-erase\b`),
    reason: "`hdparm --security-erase` (disk erase) is on the blocked list",
  },

  // Power / runlevel
  {
    pattern: asCommand(String.raw`shutdown\b`),
    reason: "`shutdown` (power/runlevel change) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`reboot\b`),
    reason: "`reboot` (power/runlevel change) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`halt\b`),
    reason: "`halt` (power/runlevel change) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`poweroff\b`),
    reason: "`poweroff` (power/runlevel change) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`init\s+[0-6]\b`),
    reason: "`init <runlevel>` is on the blocked list",
  },

  // Running a remote script unseen: the download goes straight into an interpreter.
  {
    pattern: asCommand(String.raw`(?:curl|wget)\b[^\n;&]*\|\s*(?:sudo\s+)?${SCRIPT_RUNNER}`),
    reason:
      "piping a download (curl/wget) into a shell or interpreter is on the blocked list; download it to a file and read it first",
  },
  {
    pattern: asCommand(String.raw`(?:${SCRIPT_RUNNER}|source|\.)\s+<\(\s*(?:curl|wget)\b`),
    reason:
      "running a download (curl/wget) through process substitution is on the blocked list; download it to a file and read it first",
  },

  // Reverse shells
  {
    pattern: asCommand(String.raw`nc(?:at)?\b${SAME_COMMAND}\s-[ec]\b`),
    reason: "a reverse shell via netcat (-e/-c) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`socat\b${SAME_COMMAND}\bEXEC:`, "i"),
    reason: "a reverse shell via socat EXEC: is on the blocked list",
  },

  // Fork bomb: a function that pipes into itself in the background, then is called.
  // The name can be `:`, which `\b` does not bound, so the start is anchored on a separator.
  {
    pattern: /(?:^|[\s;&|])\S+\s*\(\s*\)\s*\{[^}]*\|\s*\S+\s*&[^}]*\}\s*;\s*\S+/,
    reason: "a fork-bomb shape is on the blocked list",
  },

  // Killing processes by name can take down the user's own apps (or Jazz itself).
  {
    pattern: asCommand(String.raw`pkill\b`),
    reason: "`pkill` (kill by name) is on the blocked list; use `kill <pid>`",
  },
  {
    pattern: asCommand(String.raw`killall\b`),
    reason: "`killall` (kill by name) is on the blocked list; use `kill <pid>`",
  },

  // Permission widening
  {
    pattern: asCommand(
      String.raw`chmod\s+${SAME_COMMAND}(?:\b0?777|\ba\+rwx|\ba=rwx|\bugo\+rwx)\b`,
    ),
    reason: "`chmod 777`/a+rwx (world-writable) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`chmod\s+(?:-\S+\s+)*[ugoa]*[+=][rwxst]*s`),
    reason: "`chmod` setting setuid/setgid (symbolic mode) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`chmod\s+(?:-\S+\s+)*[246][0-7]{3}\b`),
    reason: "`chmod` setting setuid/setgid (numeric mode) is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`chown\s+(?:-\S+\s+)*(?:root|0)(?=[\s:.]|$)`),
    reason: "`chown root` is on the blocked list",
  },

  // Mounting; a bare `mount` (or `mount -l`) only lists what is mounted.
  {
    pattern: asCommand(String.raw`u?mount\b(?!\s*(?:$|[|;&)]|-[lv]\b))`),
    reason: "`mount`/`umount` is on the blocked list",
  },

  // Firewall / network surface
  {
    pattern: asCommand(String.raw`iptables\b`),
    reason: "firewall changes (iptables) are on the blocked list",
  },
  {
    pattern: asCommand(String.raw`nft\b`),
    reason: "firewall changes (nft) are on the blocked list",
  },
  {
    pattern: asCommand(String.raw`ufw\b`),
    reason: "firewall changes (ufw) are on the blocked list",
  },

  // Sending credentials off the machine. Reading them locally is fine: tool output is
  // redacted by value, which a copy to another host cannot be.
  {
    pattern: asCommand(
      String.raw`(?:scp|rsync)\b${SAME_COMMAND}(?:\/etc\/(?:shadow|sudoers)|\.ssh\/(?:id_(?:rsa|ed25519|ecdsa|dsa)|authorized_keys)|\.aws\/credentials|\.gnupg\/)`,
    ),
    reason: "copying credentials to another host (scp/rsync) is on the blocked list",
  },

  // Persistence: SSH access and scheduled jobs.
  {
    pattern: /(?:>>?|\btee\b[^\n;&|]*)\s*\S*\.ssh\/authorized_keys\b/,
    reason: "writing to ~/.ssh/authorized_keys is on the blocked list",
  },
  {
    pattern: asCommand(String.raw`crontab\s+(?!-l\b)\S`),
    reason: "replacing or removing the crontab is on the blocked list; `crontab -l` lists it",
  },

  // Accounts
  {
    pattern: asCommand(String.raw`(?:useradd|userdel|usermod|groupadd|groupdel|groupmod)\b`),
    reason: "user/group account management is on the blocked list",
  },
  { pattern: asCommand(String.raw`passwd\b`), reason: "`passwd` is on the blocked list" },
  { pattern: asCommand(String.raw`visudo\b`), reason: "`visudo` is on the blocked list" },
];

/**
 * Find the first denylist rule a command trips, or null if none. A matched rule
 * is skipped when any of its {@link ForbiddenRule.exemptions} applies to the
 * command (e.g. an `rm` whose only targets are mktemp/$TMPDIR temp paths).
 *
 * Exposed for testing and reuse. Callers must still treat the result as
 * advisory — see the doc on FORBIDDEN_COMMANDS about the limits of denylists.
 */
export function matchForbiddenCommand(command: string): ForbiddenRule | null {
  const matchable = blankQuotedOperators(command);
  for (const rule of FORBIDDEN_COMMANDS) {
    if (!rule.pattern.test(matchable)) continue;
    if (rule.exemptions?.some((exemption) => exemption.matches(command))) continue;
    return rule;
  }
  return null;
}

/**
 * Pure check: does this command match any forbidden pattern?
 */
export function isDangerousCommand(command: string): boolean {
  return matchForbiddenCommand(command) !== null;
}

/**
 * Returns the denylist error for a command, or null when the command is allowed.
 * Centralizes the blocked-command message so it can be surfaced at two points:
 * (1) before the approval prompt, so a command that will be denied never
 * asks the user to approve it, and (2) inside the execution tool as
 * defense-in-depth.
 *
 * The closing advice names `! <command>` only where the person can type it
 * (`context.offersShellEscape`); elsewhere it has the model hand them the command.
 */
export function denylistBlockedError(
  command: string,
  context: Pick<ToolExecutionContext, "offersShellEscape">,
): string | null {
  const forbidden = matchForbiddenCommand(command);
  if (!forbidden) {
    return null;
  }
  const userRunsIt =
    context.offersShellEscape === true
      ? "ask the user to run it themselves with `! <command>`"
      : "give the user the exact command so they can run it themselves";
  return `Command blocked by the built-in safety denylist: ${forbidden.reason}. This is a specific pattern match on this command — not a general restriction on running shell commands (other commands still run normally), and tool approval does not override it. If this command is genuinely safe and necessary, ${userRunsIt}.`;
}

const executeCommandParameters = z
  .object({
    command: z.string().min(1, "command cannot be empty").describe("Command to run."),
    description: z
      .string()
      .trim()
      .min(1, "description cannot be empty")
      .describe("What it does, shown at the approval gate."),
    workingDirectory: z.string().optional().describe("Defaults to the session working directory."),
    timeout: z
      .number()
      .int()
      .positive()
      .max(
        SHELL_COMMAND_MAX_TIMEOUT_MS,
        `timeout cannot exceed ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}ms (${String(
          SHELL_COMMAND_TIMEOUT_MINUTES,
        )} minutes), the hard ceiling on one command. Pass at most ${String(
          SHELL_COMMAND_MAX_TIMEOUT_MS,
        )}.`,
      )
      .optional()
      .describe(`Milliseconds. Default and maximum ${String(SHELL_COMMAND_MAX_TIMEOUT_MS)}.`),
  })
  .strict();

type ExecuteCommandArgs = z.infer<typeof executeCommandParameters>;

type ShellCommandDeps = FileSystem.FileSystem | FileSystemContextService | LoggerService;

/**
 * Per-stream cap for `execute_command` stdout and stderr. Alias of the shared
 * spawn cap so tests and docs can name the tool-specific bound.
 */
export const EXECUTE_COMMAND_OUTPUT_CAP_BYTES = DEFAULT_SPAWN_OUTPUT_CAP_BYTES;

/** What `timeout(1)` reports, and what a job killed at its cap reports here. */
const TIMEOUT_EXIT_CODE = 124;

/** The shell's base for "killed by a signal"; a signal death has no exit code of its own. */
const SIGNAL_EXIT_CODE = 128;

export type ShellCommandOutput = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

type InteractiveShellKind = "zsh" | "bash";

function interactiveShellKind(shellPath: string): InteractiveShellKind | undefined {
  const name = shellPath.split("/").pop();
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  return undefined;
}

/**
 * `<shell> -l -c <script> jazz <cwd>` for a shell whose rc file (aliases,
 * functions) the operator wants loaded — without ever setting the shell's own
 * interactive flag. `-i` would make an rc framework's guarded, interactive-only
 * setup (line editor, prompt theme) run too, and that assumes a real TTY;
 * spawned without one it throws (e.g. oh-my-zsh's `can't change option: zle`)
 * and the noise lands in the command's own stderr. Sourcing the rc file
 * explicitly, with a plain login shell, gets the aliases without that.
 * `bash` additionally needs `shopt -s expand_aliases`: bash disables alias
 * expansion in non-interactive shells even once the rc file defining them has
 * been sourced. Mirrors opencode's `packages/core/src/shell.ts`.
 */
function interactiveShellArgs(
  kind: InteractiveShellKind,
  command: string,
  cwd: string,
): readonly string[] {
  const evalCommand = `eval ${JSON.stringify(command)}`;
  let script: string;
  if (kind === "zsh") {
    script = `[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
[[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
cd -- "$1"
${evalCommand}`;
  } else {
    script = `shopt -s expand_aliases
[[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
cd -- "$1"
${evalCommand}`;
  }
  return ["-l", "-c", script, "jazz", cwd];
}

/**
 * Spawn `sh -c command` in a way that Effect can interrupt. The command runs in
 * its own process group. When the tool fiber is interrupted (Esc, `--timeout`,
 * SIGTERM, a run deadline) or the command runs out of time, the whole group gets
 * SIGTERM and, after `PROCESS_TERMINATION_GRACE_MS`, SIGKILL
 * ({@link terminateProcessGroup}), so a pipeline or a script's own children stop
 * with it and a process that handles SIGTERM can finish writing first. The
 * interrupt finalizer waits for that, so an interrupted call has stopped
 * everything it started by the time the interrupt returns. The call resolves when the shell exits: a command that
 * leaves a background job holding stdout (`server &`) returns once the shell
 * is done, after {@link PIPE_DRAIN_GRACE_MS} for the pipes to drain.
 *
 * `interactive` loads the operator's own shell rc file (aliases, functions)
 * for zsh/bash — see {@link interactiveShellArgs}. Any other `$SHELL` falls
 * back to plain `sh -c`, since there's no equivalently tested rc-loading
 * incantation for it here. Only the operator-typed `!` escape may set this —
 * the model-invoked `execute_command` tool must keep running plain `sh`, or
 * dotfile content would silently reshape what an autonomous tool call
 * executes.
 */
export function runShellCommand(input: {
  readonly command: string;
  readonly workingDir: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly interactive?: boolean;
  /**
   * Secrets to redact from stdout and stderr before they are capped, for output a model reads.
   * Shape-recognized secrets are redacted too.
   */
  readonly redact?: readonly KnownSecret[];
}): Effect.Effect<ShellCommandOutput, Error> {
  return Effect.async((resume) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let child: ChildProcess | undefined;

    const finish = (effect: Effect.Effect<ShellCommandOutput, Error>): void => {
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      resume(effect);
    };

    try {
      const shellPath = input.env["SHELL"] ?? "/bin/sh";
      const kind = input.interactive ? interactiveShellKind(shellPath) : undefined;
      const shellBinary = kind ? shellPath : "sh";
      const shellArgs = kind
        ? interactiveShellArgs(kind, input.command, input.workingDir)
        : ["-c", input.command];
      // No `timeout` option: it races the one below, and when Node's wins it kills with
      // SIGTERM and reaches `close` with a null code — reported as exit 0, so a command that
      // ran out of time came back looking like it succeeded.
      // No `uid`/`gid` either, even our own: with them Bun often finds a fast command already
      // exited before it watches it, and reports that exit inside spawn(), before any listener
      // is attached, so `close` never fires and the call hangs until its timeout.
      child = spawn(shellBinary, shellArgs, {
        cwd: input.workingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: input.env,
        detached: true,
      });
    } catch (spawnError) {
      finish(Effect.fail(toError(spawnError)));
      return;
    }

    const redact = input.redact;
    const snapshot = bindCappedStdio(
      child.stdout,
      child.stderr,
      redact === undefined
        ? EXECUTE_COMMAND_OUTPUT_CAP_BYTES
        : EXECUTE_COMMAND_OUTPUT_CAP_BYTES + REDACTION_LOOKAHEAD_BYTES,
    );
    const formatStream = (output: CappedOutput, streamName: "stdout" | "stderr"): string =>
      redact === undefined
        ? formatCappedStream(output, streamName, EXECUTE_COMMAND_OUTPUT_CAP_BYTES)
        : formatRedactedCappedStream(output, streamName, EXECUTE_COMMAND_OUTPUT_CAP_BYTES, redact);

    // A killed command keeps whatever it printed first. Failing here without reading
    // `snapshot()` threw that away, so a job that logged for fourteen minutes and then hit
    // the cap reported nothing at all. 124 is the exit code `timeout(1)` uses.
    timeoutId = setTimeout(() => {
      if (child !== undefined) {
        void terminateProcessGroup(child);
      }
      const collected = snapshot();
      const note = `Command timed out after ${input.timeoutMs}ms and was killed; any output above is what it printed first.`;
      const stderr = formatStream(collected.stderr, "stderr");
      finish(
        Effect.succeed({
          stdout: formatStream(collected.stdout, "stdout"),
          stderr: stderr.length > 0 ? `${stderr}\n${note}` : note,
          exitCode: TIMEOUT_EXIT_CODE,
        }),
      );
    }, input.timeoutMs);

    child.on("error", (error) => {
      finish(Effect.fail(error));
    });

    const finishWithExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (pipeGraceId) {
        clearTimeout(pipeGraceId);
        pipeGraceId = null;
      }
      const collected = snapshot();
      finish(
        Effect.succeed({
          stdout: formatStream(collected.stdout, "stdout"),
          stderr: formatStream(collected.stderr, "stderr"),
          // A signal death reports a null code, and calling that 0 reads as success.
          exitCode: code ?? (signal !== null ? SIGNAL_EXIT_CODE : 0),
        }),
      );
    };

    const spawned = child;
    trackChildProcess(spawned);
    let pipeGraceId: ReturnType<typeof setTimeout> | null = null;

    spawned.on("exit", (code, signal) => {
      pipeGraceId = setTimeout(() => {
        // A background job the command left running still holds the pipes open; stop
        // reading them so the call returns now.
        spawned.stdout?.destroy();
        spawned.stderr?.destroy();
        finishWithExit(code, signal);
      }, PIPE_DRAIN_GRACE_MS);
    });

    spawned.on("close", (code, signal) => {
      finishWithExit(code, signal);
    });

    return Effect.sync(() => {
      if (pipeGraceId) {
        clearTimeout(pipeGraceId);
        pipeGraceId = null;
      }
      if (settled) return;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }).pipe(Effect.zipRight(Effect.promise(() => terminateProcessGroup(spawned))));
  });
}

/**
 * Create shell command tools (approval + execution pair).
 *
 * SECURITY WARNING: This tool can execute arbitrary commands on the system.
 * Consider the following security implications:
 * - Commands run with the same privileges as the jazz process
 * - Environment variables may be exposed to executed commands
 * - Network access is available to executed commands
 * - File system access is available within the working directory context
 */
export function createShellCommandTools(): ApprovalToolPair<ShellCommandDeps> {
  const config: ApprovalToolConfig<ShellCommandDeps, ExecuteCommandArgs> = {
    name: "execute_command",
    disclosure: "private",
    description:
      "Run a non-interactive shell command; stdin is empty. Use a dedicated tool whenever one covers the task, including tools from search_tools; use this for git and everything else. " +
      "Read-only commands may be auto-approved; anything that mutates needs approval. " +
      "For anything that needs sudo, ask the person to run it. The environment has no secrets and takes no env vars. " +
      "Put a secret from ask_user_secret in the command as its placeholder; the person approves every such command. " +
      "A command is killed after 15 minutes; for longer work, background it and poll with wait_for.",
    tags: ["shell", "execution"],
    riskLevel: "unknown",
    userSecretArguments: ["command"],
    timeoutMs: SHELL_COMMAND_MAX_TIMEOUT_MS,
    parameters: executeCommandParameters,
    validate: makeZodValidator(executeCommandParameters),

    approvalMessage: (args: ExecuteCommandArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        // Gate the approval prompt on the denylist: a command that the execution
        // tool will refuse should never be put in front of the user to approve.
        // Returning `skipApproval` sends the blocked error straight back to the
        // model so it can adapt.
        const blocked = denylistBlockedError(args.command, context);
        if (blocked) {
          return {
            skipApproval: true,
            toolResult: { success: false, result: null, error: blocked } as const,
          };
        }

        const shell = yield* FileSystemContextServiceTag;
        const cwd = yield* shell.getCwd({
          agentId: context.agentId,
          ...(context.conversationId && { conversationId: context.conversationId }),
        });

        const workingDir = args.workingDirectory || cwd;
        const timeout = args.timeout ?? SHELL_COMMAND_MAX_TIMEOUT_MS;
        const description = args.description.trim();

        const message = `Command: ${args.command}
Description: ${description}
Working Directory: ${workingDir}
Timeout: ${formatDuration(timeout)}

This command will be executed on your system. Only approve commands you trust.`;
        const typedSecrets =
          context.userSecrets === undefined
            ? []
            : userSecretNamesIn(args.command, context.userSecrets);
        if (typedSecrets.length === 0) {
          return message;
        }
        const placeholders = typedSecrets.map(redactionPlaceholder).join(", ");
        return {
          message: `${message}\n\nApproving puts the secret you typed in place of ${placeholders} when the command runs.`,
          ...(secretUseNeedsPerson() ? { alwaysAsk: true as const } : {}),
        };
      }),

    approvalErrorMessage: "Command execution requires explicit user approval for security reasons.",
    editableArg: "command",

    handler: (args: ExecuteCommandArgs, context: ToolExecutionContext) =>
      Effect.gen(function* () {
        const shell = yield* FileSystemContextServiceTag;
        const logger = yield* LoggerServiceTag;

        // Resolve the working directory against this conversation's cwd. Any existing
        // directory is accepted, absolute paths included: this is not a confinement boundary.
        const key = buildKeyFromContext(context);
        const workingDir = args.workingDirectory
          ? yield* shell.resolvePath(key, args.workingDirectory)
          : yield* shell.getCwd(key);
        const timeout = args.timeout ?? SHELL_COMMAND_MAX_TIMEOUT_MS;

        // Basic safety checks
        const command = args.command.trim();
        if (!command) {
          return {
            success: false,
            result: null,
            error: "Command cannot be empty",
          };
        }

        const blocked = denylistBlockedError(command, context);
        if (blocked) {
          return {
            success: false,
            result: null,
            error: blocked,
          };
        }

        try {
          // Sanitize environment variables for security, exempting any
          // agent-configured allowlist from the sensitive-name scrub.
          const envAllowlist = context.parentAgent?.config.envAllowlist ?? [];
          // The run's zone governs child processes too. `date`, `khal` and
          // `gcalcli` read TZ, not the agent's notion of "now", so without this a
          // caller in Europe/Rome is shown their own calendar in whatever zone the
          // host happens to be set to.
          const sanitizedEnv = createSanitizedEnv(
            typeof context.timezone === "string" && context.timezone.length > 0
              ? { TZ: context.timezone }
              : {},
            envAllowlist,
          );

          const result = yield* runShellCommand({
            command,
            workingDir,
            timeoutMs: timeout,
            env: sanitizedEnv,
            redact: yield* toolKnownSecrets(),
          }).pipe(
            Effect.catchAll((error: unknown) =>
              Effect.succeed({
                stdout: "",
                stderr: "",
                exitCode: -1,
                error: toError(error).message,
              }),
            ),
          );

          // Check if this was a timeout or other error
          if ("error" in result) {
            return {
              success: false,
              result: null,
              error: result.error,
            };
          }

          yield* logger.info("Command executed", {
            exitCode: result.exitCode,
            stdoutChars: result.stdout.length,
            stderrChars: result.stderr.length,
          });

          return {
            success: true,
            result: {
              command: args.command,
              workingDirectory: workingDir,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              success: result.exitCode === 0,
            },
            // Jazz cannot tell what a command read, so its output is always outside content.
            untrusted: { kind: "external", source: "execute_command output" },
          };
        } catch (error) {
          const errorMessage = toError(error).message;
          return {
            success: false,
            result: null,
            error: `Command execution failed: ${errorMessage}`,
          };
        }
      }),

    createSummary: (result: ToolExecutionResult) => {
      if (!result.success) {
        return "Command execution failed";
      }
      const data = result.result;
      if (data && typeof data === "object" && "command" in data && "exitCode" in data) {
        const command = data.command as string;
        const exitCode = data.exitCode as number;
        const success = exitCode === 0;
        return `Command "${command}" ${success ? "succeeded" : "failed"} (exit code: ${exitCode})`;
      }
      return "Command executed";
    },
  };

  return defineApprovalTool<ShellCommandDeps, ExecuteCommandArgs>(config);
}

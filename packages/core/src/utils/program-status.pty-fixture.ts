/**
 * Runs the production program-status emitters once, in order, so a PTY test can
 * assert the raw bytes that reach a real terminal. No fakes: same functions,
 * same /dev/tty write path a live run uses.
 */
import { notifyTerminal, reportProgramCwd, reportProgramStatus } from "./program-status";

reportProgramStatus({ state: "working", msg: "running tests" });
reportProgramStatus({ state: "working", msg: "running tests" });
reportProgramStatus({ state: "blocked", kind: "permission", msg: "Delete the cache directory?" });
reportProgramStatus({ state: "done" });
notifyTerminal("Jazz: Delete the cache directory?");
reportProgramCwd(process.cwd());

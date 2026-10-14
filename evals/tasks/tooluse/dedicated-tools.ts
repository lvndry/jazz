/**
 * Tool choice: three everyday file jobs where a dedicated tool and a shell program both
 * work. The prompts never name a tool, so a pass means the agent reached for grep,
 * read_file, or mv on its own and never ran the shell equivalent alongside it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dedicatedToolCheck } from "../../checks";
import type { EvalTask } from "../../types";

const CONFIG_FILES: Record<string, string> = {
  "src/config/cache.ts": "export const CACHE_TTL_SECONDS = 300;\n",
  "src/config/session.ts": "export const SESSION_IDLE_MINUTES = 30;\n",
  "src/auth/tokens.ts":
    "import { SESSION_IDLE_MINUTES } from '../config/session';\n\nexport const LEGACY_TOKEN_TTL = 86_400;\n",
  "src/auth/index.ts": "export * from './tokens';\n",
  "README.md": "Token lifetimes live in src/.\n",
};

const LOG_LINE_COUNT = 2_000;
const ASKED_LOG_LINE = 1_500;
const ASKED_LOG_TEXT = "request 7f3a92 finished with status 503 after 4120ms";

function logLine(lineNumber: number): string {
  return lineNumber === ASKED_LOG_LINE
    ? ASKED_LOG_TEXT
    : `request ${lineNumber.toString(16).padStart(6, "0")} finished with status 200 after ${lineNumber % 97}ms`;
}

const DRAFT_PATH = "notes/draft.md";
const RENAMED_PATH = "notes/2026-10-14-launch.md";
const DRAFT_CONTENT = "# Launch\n\n- ship the denylist rework\n- write the changelog\n";

export const tasks: EvalTask[] = [
  {
    id: "tooluse-dedicated-search",
    domain: "tooluse",
    baseDifficulty: "trivial",
    prompt: "Which file under src/ defines LEGACY_TOKEN_TTL, and what is its value?",
    setup(workspaceDir) {
      for (const [path, content] of Object.entries(CONFIG_FILES)) {
        mkdirSync(join(workspaceDir, path, ".."), { recursive: true });
        writeFileSync(join(workspaceDir, path), content);
      }
    },
    check(result) {
      const answered = result.answer.includes("tokens.ts") && /86[_,]?400/.test(result.answer);
      const choice = dedicatedToolCheck(result, "grep", ["grep", "rg", "ag", "ack"]);
      const pass = answered && choice.pass;
      return { pass, score: pass ? 1 : 0, detail: `answer=${answered}, ${choice.detail}` };
    },
  },
  {
    id: "tooluse-dedicated-line-range",
    domain: "tooluse",
    baseDifficulty: "trivial",
    prompt: `What does line ${String(ASKED_LOG_LINE)} of logs/app.log say?`,
    setup(workspaceDir) {
      mkdirSync(join(workspaceDir, "logs"), { recursive: true });
      const lines = Array.from({ length: LOG_LINE_COUNT }, (_, index) => logLine(index + 1));
      writeFileSync(join(workspaceDir, "logs/app.log"), `${lines.join("\n")}\n`);
    },
    check(result) {
      const answered = result.answer.includes("7f3a92") && result.answer.includes("503");
      const choice = dedicatedToolCheck(result, "read_file", [
        "sed",
        "head",
        "tail",
        "cat",
        "awk",
        "nl",
        "less",
      ]);
      const pass = answered && choice.pass;
      return { pass, score: pass ? 1 : 0, detail: `answer=${answered}, ${choice.detail}` };
    },
  },
  {
    id: "tooluse-dedicated-rename",
    domain: "tooluse",
    baseDifficulty: "trivial",
    prompt: `Rename ${DRAFT_PATH} to ${RENAMED_PATH}.`,
    setup(workspaceDir) {
      mkdirSync(join(workspaceDir, "notes"), { recursive: true });
      writeFileSync(join(workspaceDir, DRAFT_PATH), DRAFT_CONTENT);
    },
    check(result, workspaceDir) {
      const renamedPath = join(workspaceDir, RENAMED_PATH);
      const renamed =
        !existsSync(join(workspaceDir, DRAFT_PATH)) &&
        existsSync(renamedPath) &&
        readFileSync(renamedPath, "utf8") === DRAFT_CONTENT;
      const choice = dedicatedToolCheck(result, "mv", ["mv", "cp"]);
      const pass = renamed && choice.pass;
      return { pass, score: pass ? 1 : 0, detail: `renamed=${renamed}, ${choice.detail}` };
    },
  },
];

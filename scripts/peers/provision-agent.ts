/**
 * Create a jazz agent non-interactively, for demo/CI scripts.
 *
 * `jazz agent create` is an Ink TUI wizard with no CLI flags — by design, per
 * docs/guide/creating-agents.md: "if you want to script agent creation, write the JSON file
 * directly." This does exactly that: one file at `$JAZZ_HOME/agents/<id>.json`, the same
 * shape the wizard itself writes.
 *
 * Usage:
 *   JAZZ_HOME=/path/to/home bun run scripts/provision-agent.ts <name> [tool ...]
 *
 * Defaults to `openrouter`/`minimax/minimax-m2.7:free`, verified live at the time of writing
 * against https://openrouter.ai/api/v1/models (filtered to `:free` ids whose
 * `supported_parameters` include `tools`). Two things were tried and rejected before this:
 * `qwen/qwen3-next-80b-a3b-instruct:free` (this repo's own eval fixture) broke within the same
 * day — OpenRouter pulled its free tier and started rejecting it with "use this slug instead:
 * qwen/...-instruct" (the paid one) — and the `openrouter/free` router itself (the "Free
 * Models Router" docs/guide/quick-start.md recommends) consistently routed to a broken
 * "Stealth" backend returning `502 [Stealth] Invalid URL`. A free tier is inherently a moving
 * target; override with `JAZZ_DEMO_PROVIDER`/`JAZZ_DEMO_MODEL` if this one goes the same way —
 * check the API above for current `:free` ids with tool support.
 *
 * Needs an OpenRouter key to actually *run* (creating the agent itself needs none) —
 * `OPENROUTER_API_KEY` if set, otherwise whatever `llm.openrouter.api_key` is already in the
 * OS keyring. That lookup is by a fixed account name, not scoped to `$JAZZ_HOME`, so an agent
 * already configured with an OpenRouter key on this machine covers every `$JAZZ_HOME` on it,
 * this one included — nothing further to set up.
 */

import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Same resolution as `getJazzHomeDirectory()` in `packages/core/src/utils/paths.ts`,
 * inlined rather than imported: that module pulls in the asset-extraction machinery meant for
 * the compiled CLI binary, which is unnecessary weight for a one-off provisioning script and
 * isn't set up to be imported from outside the `packages/*` workspace tree.
 */
function jazzHomeDirectory(): string {
  const jazzHome = process.env["JAZZ_HOME"];
  if (jazzHome && jazzHome.trim().length > 0) return path.resolve(jazzHome.trim());
  const homeDir = os.homedir();
  return homeDir && homeDir.trim().length > 0
    ? path.join(homeDir, ".jazz")
    : path.resolve(process.cwd(), ".jazz");
}

const [name, ...tools] = process.argv.slice(2);

if (name === undefined) {
  process.stderr.write("Usage: bun run scripts/provision-agent.ts <name> [tool ...]\n");
  process.exit(1);
}

const agentsDirectory = path.join(jazzHomeDirectory(), "agents");
await nodeFs.mkdir(agentsDirectory, { recursive: true });

const now = new Date().toISOString();
const agent = {
  id: randomUUID(),
  name,
  config: {
    persona: "default",
    llmProvider: process.env["JAZZ_DEMO_PROVIDER"] ?? "openrouter",
    llmModel: process.env["JAZZ_DEMO_MODEL"] ?? "minimax/minimax-m2.7:free",
    ...(tools.length > 0 ? { tools } : {}),
  },
  createdAt: now,
  updatedAt: now,
};

const destination = path.join(agentsDirectory, `${agent.id}.json`);
await nodeFs.writeFile(destination, JSON.stringify(agent, null, 2), "utf-8");

process.stdout.write(`Created agent "${name}" (${agent.id}) at ${destination}\n`);

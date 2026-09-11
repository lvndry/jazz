/**
 * @fileoverview `jazz photon` - reach your agent on its own iMessage line.
 *
 * Unlike `jazz imessage`, the agent is not your Apple account: Photon assigns
 * it a line of its own, so there is a real conversation to open instead of a
 * chat with yourself and a trigger word. Runs anywhere - no Mac required.
 *
 * `--agent` seeds the bridge from an agent you already have, copied into the
 * bridge's own home so the original keeps its name and stays yours.
 */

export async function photonCommand(agent?: string): Promise<void> {
  if (agent !== undefined) await selectSeedAgent(agent);
  const { startBridge } = await import("@jazz/photon-bot/bridge");
  await startBridge();
}

/** Resolve `--agent` against your agent store, handed over as JAZZ_PHOTON_AGENT. */
async function selectSeedAgent(query: string): Promise<void> {
  const { agentStoreDirectory, listAgents, matchAgent } =
    await import("@jazz/bot-shared/seed-import");

  const home = agentStoreDirectory();
  const agents = listAgents(home);
  const match = matchAgent(agents, query);
  const list = (found: readonly { id: string; name: string }[]): string =>
    found.map((entry) => `  ${entry.id}  ${entry.name}`).join("\n");

  if (match.kind === "ambiguous") {
    throw new Error(
      `More than one agent is called "${query}". Name it by id instead:\n${list(match.matches)}`,
    );
  }
  if (match.kind === "missing") {
    throw new Error(
      agents.length === 0
        ? `No agents in ${home}. Make one with \`jazz create\`.`
        : `No agent "${query}" in ${home}. There is:\n${list(agents)}`,
    );
  }

  process.env["JAZZ_PHOTON_AGENT"] = match.id;
}

/**
 * @fileoverview `jazz whatsapp` — reach your agent from WhatsApp.
 *
 * The bridge links to your account as a device, the same standing WhatsApp Web
 * has, which means it runs wherever you are rather than in a container the way
 * Telegram and Discord do. Without this command an installed binary could not
 * start it at all.
 *
 * `--agent` seeds the bridge from an agent you already have. It is copied into
 * the bridge's own home, so the original keeps its name and stays yours.
 */

export async function whatsappCommand(agent?: string): Promise<void> {
  if (agent !== undefined) await selectSeedAgent(agent);
  const { startBridge } = await import("@jazz/whatsapp-bot/bridge");
  await startBridge();
}

/**
 * Resolve `--agent` against your agent store.
 *
 * Handed over as JAZZ_WHATSAPP_AGENT, which is what the bridge reads.
 */
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

  process.env["JAZZ_WHATSAPP_AGENT"] = match.id;
}

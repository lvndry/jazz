import * as path from "node:path";
import {
  isApprovalPolicyFlag,
  isReasoningEffortFlag,
  parseEventCategories,
  resolveStreamOption,
} from "@jazz/cli/commands/run/flags";
import {
  parseDurationMs,
  parsePositiveFloat,
  parsePositiveInt,
} from "@jazz/cli/utils/option-parsers";
import { isPeerTier, PEER_TIERS } from "@jazz/core/types/peer";
import { setCurrentCommandName } from "@jazz/core/utils/current-command";
import { parseProviderModel } from "@jazz/core/utils/provider-model";
import { Command } from "commander";
import packageJson from "../../../package.json";

/**
 * CLI Application setup and command registration
 *
 * This module handles all Commander.js setup and command registration,
 * keeping the main entry point focused on bootstrapping.
 */

interface CliOptions {
  verbose?: boolean;
  debug?: boolean;
  config?: string;
  dataDir?: string;
  output?: string;
  tui?: boolean;
}

interface CliRuntimeOptions {
  readonly verbose?: boolean | undefined;
  readonly debug?: boolean | undefined;
  readonly configPath?: string | undefined;
}

interface CliRunOptions {
  readonly skipCatchUp?: boolean;
  readonly skipUpdateCheck?: boolean;
  /** Live until the user leaves. Print-and-exit commands omit this. */
  readonly session?: boolean;
}

type AppLayerModule = typeof import("./app-layer");
type CliCommandEffect = Parameters<AppLayerModule["runCliEffect"]>[0];

const MEDIA_CAPABILITIES = ["image", "audio", "video"] as const;

function isMediaCapability(value: string): value is (typeof MEDIA_CAPABILITIES)[number] {
  return (MEDIA_CAPABILITIES as readonly string[]).includes(value);
}

function cliRuntimeOptions(program: Command): CliRuntimeOptions {
  const opts = program.opts<CliOptions>();
  return {
    verbose: opts.verbose,
    debug: opts.debug,
    configPath: opts.config,
  };
}

// Actions load the agent stack only when a command actually runs, so
// `jazz --help` / `jazz --version` stay on the Commander tree.
async function runCliAction(
  loadEffect: () => Promise<CliCommandEffect>,
  config: CliRuntimeOptions,
  options?: CliRunOptions,
): Promise<void> {
  try {
    const [{ runCliEffect }, effect] = await Promise.all([import("./app-layer"), loadEffect()]);
    runCliEffect(effect, config, options);
  } catch (error) {
    console.error("Fatal error:", error);
    throw error;
  }
}

/** Build the full command path (`agent list`) by walking up to the root program. */
function commandPath(command: Command): string {
  const segments: string[] = [];
  let current: Command | null = command;
  while (current && current.parent) {
    segments.unshift(current.name());
    current = current.parent;
  }
  return segments.length > 0 ? segments.join(" ") : command.name();
}

/**
 * Register the one-shot `run` command — non-interactive agent invocation for
 * scripts and webhook handlers.
 */
function registerRunCommand(program: Command): void {
  program
    .command("run [prompt]")
    .description(
      "Run an agent once non-interactively (for scripts/webhooks). Prompt comes from the argument or piped stdin; the answer goes to stdout, all chatter to stderr.",
    )
    .requiredOption("--agent <agentId>", "Agent ID or name to run")
    .option("--json", "Emit a single JSON envelope { ok, answer, costUSD, tokenUsage, toolCalls }")
    .option(
      "--approval-policy <policy>",
      "Auto-approve tools up to a risk level: read-only | low-risk | high-risk (high-risk approves everything). Tools above the level are declined.",
    )
    .option(
      "--auto-approve-tools <names>",
      "Comma-separated tool names to auto-approve without prompting, regardless of --approval-policy (e.g. execute_command). Narrower than raising the whole policy tier.",
    )
    .option(
      "--timezone <iana-tz>",
      "IANA timezone (e.g. Europe/Paris) used to resolve relative/clock times for this run, e.g. the add_reminder tool. Defaults to UTC.",
    )
    .option(
      "--timeout <ms>",
      "Abort the run after this many milliseconds",
      parsePositiveInt("--timeout"),
    )
    .option(
      "--max-iterations <n>",
      "Maximum agent reasoning iterations for this run",
      parsePositiveInt("--max-iterations"),
    )
    .option(
      "--max-cost-usd <dollars>",
      "Abort the run once cumulative spend (own + sub-agent) reaches this many dollars. Checked between iterations, not preemptively — see docs/reference/configuration.md.",
      parsePositiveFloat("--max-cost-usd"),
    )
    .option(
      "--max-tokens <n>",
      "Abort the run once cumulative own tokens (prompt + completion) reach this count. Checked between iterations, same as --max-cost-usd but needs no model pricing.",
      parsePositiveInt("--max-tokens"),
    )
    .option(
      "--max-duration-ms <ms>",
      "Abort the run once elapsed wall-clock time reaches this many milliseconds. The agent gets pressure nudges at 50/80/90% elapsed, then the run stops between iterations.",
      parsePositiveInt("--max-duration-ms"),
    )
    .option(
      "--events <categories>",
      "Emit selected event categories as NDJSON to stderr during the run (comma-separated: tools,reasoning,text,usage,approval,subagent,all). stdout stays the clean payload.",
    )
    .option(
      "--reasoning <effort>",
      "Reasoning effort for this run: low | medium | high | disable (overrides the agent's config)",
    )
    .option(
      "--conversation <id>",
      "Stable conversation key (e.g. a Telegram chat id). Loads prior history for this key before the run and saves the updated transcript after, giving repeated invocations shared memory. Omit for a stateless one-shot run.",
    )
    .option(
      "--stream",
      "Force streaming mode. Required for --events to emit in non-TTY contexts (scripts, webhooks), where streaming is otherwise auto-disabled.",
    )
    .option("--no-stream", "Disable streaming mode")
    .option(
      "--interactive-stdin",
      "Declare that this caller relays the agent's questions to a human and writes answers back on stdin (a chat bridge). Not needed on a terminal, where questions are asked directly. Without either, tools that ask the user are withheld so an unattended run never stops for an answer nobody will see.",
    )
    .option(
      "--ephemeral",
      "Skip persistence entirely: --conversation is ignored (no history load/save) and long-term memory writes are withheld. Nothing about this run touches disk.",
    )
    .option(
      "--history-json <json>",
      "Inline JSON array of prior ChatMessages, used only with --ephemeral in place of --conversation — pass back the `messages` field from a previous --ephemeral --json response to keep multi-turn context without persistence.",
    )
    .option(
      "--park",
      "When a gated tool needs approval nobody here can give, save the run and exit 2 instead of declining. Resume it later with `jazz runs approve <id>`. Only use this where somebody will actually answer.",
    )
    .option(
      "--with-vision <provider/model>",
      "Bind the vision companion for this run (overrides the agent's config), e.g. anthropic/claude-sonnet-4-5",
    )
    .option(
      "--with-audio <provider/model>",
      "Bind the audio companion for this run (overrides the agent's config)",
    )
    .option(
      "--with-video <provider/model>",
      "Bind the video companion for this run (overrides the agent's config)",
    )
    .action(
      (
        prompt: string | undefined,
        options: {
          agent: string;
          json?: boolean;
          approvalPolicy?: string;
          autoApproveTools?: string;
          timezone?: string;
          timeout?: number;
          maxIterations?: number;
          maxCostUsd?: number;
          maxTokens?: number;
          maxDurationMs?: number;
          events?: string;
          reasoning?: string;
          conversation?: string;
          stream?: boolean;
          noStream?: boolean;
          interactiveStdin?: boolean;
          ephemeral?: boolean;
          historyJson?: string;
          park?: boolean;
          withVision?: string;
          withAudio?: string;
          withVideo?: string;
        },
      ) => {
        const json = options.json === true;

        if (options.approvalPolicy !== undefined && !isApprovalPolicyFlag(options.approvalPolicy)) {
          const message = `Invalid --approval-policy "${options.approvalPolicy}". Expected read-only, low-risk, or high-risk.`;
          if (json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: message, costUSD: 0 })}\n`);
          } else {
            process.stderr.write(`${message}\n`);
          }
          process.exitCode = 1;
          return;
        }

        const eventCategories =
          options.events !== undefined ? parseEventCategories(options.events) : undefined;
        if (eventCategories !== undefined && !eventCategories.ok) {
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: false, error: eventCategories.error, costUSD: 0 })}\n`,
            );
          } else {
            process.stderr.write(`${eventCategories.error}\n`);
          }
          process.exitCode = 1;
          return;
        }

        if (options.reasoning !== undefined && !isReasoningEffortFlag(options.reasoning)) {
          const message = `Invalid --reasoning "${options.reasoning}". Expected low, medium, high, or disable.`;
          if (json) {
            process.stdout.write(`${JSON.stringify({ ok: false, error: message, costUSD: 0 })}\n`);
          } else {
            process.stderr.write(`${message}\n`);
          }
          process.exitCode = 1;
          return;
        }

        if (options.timezone !== undefined) {
          try {
            new Intl.DateTimeFormat(undefined, { timeZone: options.timezone });
          } catch {
            const message = `Invalid --timezone "${options.timezone}". Expected an IANA timezone name (e.g. Europe/Paris).`;
            if (json) {
              process.stdout.write(
                `${JSON.stringify({ ok: false, error: message, costUSD: 0 })}\n`,
              );
            } else {
              process.stderr.write(`${message}\n`);
            }
            process.exitCode = 1;
            return;
          }
        }

        const companionFlags: Record<string, string | undefined> = {
          vision: options.withVision,
          audio: options.withAudio,
          video: options.withVideo,
        };
        for (const [capability, companion] of Object.entries(companionFlags)) {
          if (companion !== undefined && parseProviderModel(companion) === null) {
            const message = `Invalid --with-${capability} "${companion}". Expected provider/model, e.g. anthropic/claude-sonnet-4-5.`;
            if (json) {
              process.stdout.write(
                `${JSON.stringify({ ok: false, error: message, costUSD: 0 })}\n`,
              );
            } else {
              process.stderr.write(`${message}\n`);
            }
            process.exitCode = 1;
            return;
          }
        }

        // Force plain terminal so Ink never mounts and writes to stdout; the
        // one-shot presentation layer keeps stdout clean for the payload.
        process.env["JAZZ_NO_TUI"] = "1";

        const autoApproveTools = options.autoApproveTools
          ?.split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);

        return runCliAction(
          () =>
            import("@jazz/cli/commands/run/execute").then((mod) =>
              mod.runAgentOnceCommand(options.agent, prompt, {
                json,
                ...(options.approvalPolicy !== undefined &&
                isApprovalPolicyFlag(options.approvalPolicy)
                  ? { approvalPolicy: options.approvalPolicy }
                  : {}),
                ...(autoApproveTools && autoApproveTools.length > 0
                  ? { autoApprovedTools: autoApproveTools }
                  : {}),
                ...(options.timezone !== undefined ? { timezone: options.timezone } : {}),
                ...(options.reasoning !== undefined && isReasoningEffortFlag(options.reasoning)
                  ? { reasoningEffort: options.reasoning }
                  : {}),
                ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
                ...(options.maxIterations !== undefined
                  ? { maxIterations: options.maxIterations }
                  : {}),
                ...(options.maxCostUsd !== undefined ? { maxCostUSD: options.maxCostUsd } : {}),
                ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
                ...(options.maxDurationMs !== undefined
                  ? { maxDurationMs: options.maxDurationMs }
                  : {}),
                ...(eventCategories?.ok ? { eventTypes: eventCategories.types } : {}),
                ...(options.conversation !== undefined
                  ? { conversationId: options.conversation }
                  : {}),
                ...resolveStreamOption(options, eventCategories),
                ...(options.interactiveStdin === true ? { interactiveStdin: true } : {}),
                ...(options.ephemeral === true ? { ephemeral: true } : {}),
                ...(options.historyJson !== undefined ? { historyJson: options.historyJson } : {}),
                ...(options.park === true ? { park: true } : {}),
                ...(Object.values(companionFlags).some((value) => value !== undefined)
                  ? {
                      companions: Object.fromEntries(
                        Object.entries(companionFlags).filter((entry) => entry[1] !== undefined),
                      ),
                    }
                  : {}),
              }),
            ),
          cliRuntimeOptions(program),
          { skipCatchUp: true, skipUpdateCheck: true },
        );
      },
    );
}

/**
 * Register agent-related commands
 */
function registerAgentCommands(program: Command): void {
  const agentCommand = program.command("agent").description("Manage agents");

  agentCommand
    .command("list")
    .alias("ls")
    .description("List all agents")
    .option(
      "--can <media>",
      "Only agents whose model can generate this: image, audio, or video. Shows how to get one when none can.",
    )
    .action((commandOptions: { can?: string }) => {
      const requested = commandOptions.can;
      if (requested !== undefined && !isMediaCapability(requested)) {
        console.error(
          `Unknown capability "${requested}". Use one of: ${MEDIA_CAPABILITIES.join(", ")}`,
        );
        process.exitCode = 1;
        return;
      }
      return runCliAction(
        () =>
          import("@jazz/cli/commands/agent-management").then((mod) =>
            mod.listAgentsCommand(requested ? { can: requested } : {}),
          ),
        cliRuntimeOptions(program),
      );
    });

  agentCommand
    .command("create")
    .description("Create a new agent (interactive mode)")
    .action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/create-agent").then((mod) => mod.createAgentCommand()),
        cliRuntimeOptions(program),
        { session: true },
      ),
    );

  agentCommand
    .command("show <agentId>")
    .description("Get an agent details")
    .action((agentId: string) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/agent-management").then((mod) => mod.getAgentCommand(agentId)),
        cliRuntimeOptions(program),
      ),
    );

  agentCommand
    .command("edit <agentId>")
    .description("Edit an existing agent")
    .action((agentId: string) =>
      runCliAction(
        () => import("@jazz/cli/commands/edit-agent").then((mod) => mod.editAgentCommand(agentId)),
        cliRuntimeOptions(program),
        { session: true },
      ),
    );

  agentCommand
    .command("delete <agentId>")
    .alias("remove")
    .alias("rm")
    .description("Delete an agent")
    .option("-y, --yes", "Delete without asking for confirmation")
    .option("-f, --force", "Alias for --yes")
    .action((agentId: string, options: { yes?: boolean; force?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/agent-management").then((mod) =>
            mod.deleteAgentCommand(agentId, {
              skipConfirmation: options.yes === true || options.force === true,
            }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  agentCommand
    .command("chat <agentIdentifier>")
    .description("Start a chat with an AI agent by ID or name")
    .option("--stream", "Force streaming mode (real-time output)")
    .option("--no-stream", "Disable streaming mode")
    .option(
      "--max-iterations <n>",
      "Maximum agent reasoning iterations per turn (default 80)",
      parsePositiveInt("--max-iterations"),
    )
    .option(
      "--ephemeral",
      "Skip persistence for this session entirely: no conversation history save, no session log, and long-term memory writes are withheld. Nothing about the session touches disk.",
    )
    .action(
      (
        agentIdentifier: string,
        options: {
          stream?: boolean;
          noStream?: boolean;
          maxIterations?: number;
          ephemeral?: boolean;
        },
      ) => {
        const streamOption =
          options.noStream === true ? false : options.stream === true ? true : undefined;
        return runCliAction(
          () =>
            import("@jazz/cli/commands/chat-agent").then((mod) =>
              mod.chatWithAIAgentCommand(agentIdentifier, {
                ...(streamOption !== undefined ? { stream: streamOption } : {}),
                ...(options.maxIterations !== undefined
                  ? { maxIterations: options.maxIterations }
                  : {}),
                ...(options.ephemeral === true ? { ephemeral: true } : {}),
              }),
            ),
          cliRuntimeOptions(program),
          { session: true },
        );
      },
    );
}

/**
 * Register configuration-related commands
 */
function registerConfigCommands(program: Command): void {
  const configCommand = program.command("config").description("Manage configuration");

  configCommand
    .command("get <key>")
    .description("Get a configuration value")
    .action((key: string) =>
      runCliAction(
        () => import("@jazz/cli/commands/config").then((mod) => mod.getConfigCommand(key)),
        cliRuntimeOptions(program),
      ),
    );

  configCommand
    .command("set <key> [value]")
    .description("Set a configuration value")
    .action((key: string, value?: string) =>
      runCliAction(
        () => import("@jazz/cli/commands/config").then((mod) => mod.setConfigCommand(key, value)),
        cliRuntimeOptions(program),
      ),
    );

  configCommand
    .command("show")
    .description("Show all configuration values")
    .action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/config").then((mod) => mod.listConfigCommand()),
        cliRuntimeOptions(program),
      ),
    );
}

/** Accumulate a repeatable Commander option into an array. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Register MCP server management commands
 */
function registerMCPCommands(program: Command): void {
  const mcpCommand = program.command("mcp").description("Manage MCP servers");

  function run(loadEffect: () => Promise<CliCommandEffect>): Promise<void> {
    return runCliAction(loadEffect, cliRuntimeOptions(program));
  }

  mcpCommand
    .command("add [nameOrJson] [commandAndArgs...]")
    .description("Add an MCP server by name + command, or from JSON (inline, --file, stdin)")
    // A server command with its own flags (`npx -y ...`) has to sit after `--`,
    // or Commander claims those flags for itself.
    .addHelpText(
      "after",
      `
Examples:
  jazz mcp add notes -- npx -y @modelcontextprotocol/server-filesystem ~/notes
  jazz mcp add linear --transport http https://mcp.linear.app/mcp
  jazz mcp add db --env PGHOST=localhost -- my-db-server
  jazz mcp add '{"srv": {"command": "my-server"}}'
  pbpaste | jazz mcp add

Put the server's own command after \`--\` whenever it takes flags of its own.
Remote servers that need a login: run \`jazz mcp auth <name>\` after adding.
`,
    )
    .option("-f, --file <path>", "Read MCP server JSON from a file")
    .option("-t, --transport <type>", "Transport to use: stdio (default) or http")
    .option("-e, --env <KEY=VALUE>", "Environment variable for a stdio server", collect, [])
    .option("-H, --header <KEY=VALUE>", "HTTP header for an http server", collect, [])
    .option("--trusted", "Let this server's read-only annotations skip approval prompts")
    .action(
      (
        nameOrJson: string | undefined,
        commandAndArgs: string[] | undefined,
        options: {
          file?: string;
          transport?: string;
          env?: string[];
          header?: string[];
          trusted?: boolean;
        },
      ) =>
        run(() =>
          import("@jazz/cli/commands/mcp").then((mod) =>
            mod.addMcpServerCommand(nameOrJson, commandAndArgs ?? [], options),
          ),
        ),
    );

  mcpCommand
    .command("list")
    .alias("ls")
    .description("List all configured MCP servers")
    .option("--tools", "Connect to each server and show the tools it advertises")
    .action((options: { tools?: boolean }) =>
      run(() => import("@jazz/cli/commands/mcp").then((mod) => mod.listMcpServersCommand(options))),
    );

  mcpCommand
    .command("test <name>")
    .description("Connect to one server and report its tools, prompts, and capabilities")
    .action((name: string) =>
      run(() => import("@jazz/cli/commands/mcp").then((mod) => mod.testMcpServerCommand(name))),
    );

  mcpCommand
    .command("remove [name]")
    .alias("rm")
    .description("Remove an MCP server")
    .option("-y, --yes", "Skip the confirmation prompt")
    .action((name: string | undefined, options: { yes?: boolean }) =>
      run(() =>
        import("@jazz/cli/commands/mcp").then((mod) => mod.removeMcpServerCommand(name, options)),
      ),
    );

  mcpCommand
    .command("enable [name]")
    .description("Enable a disabled MCP server")
    .action((name?: string) =>
      run(() => import("@jazz/cli/commands/mcp").then((mod) => mod.enableMcpServerCommand(name))),
    );

  mcpCommand
    .command("disable [name]")
    .description("Disable an enabled MCP server")
    .action((name?: string) =>
      run(() => import("@jazz/cli/commands/mcp").then((mod) => mod.disableMcpServerCommand(name))),
    );

  mcpCommand
    .command("trust [name]")
    .description("Let a server's read-only tool annotations skip approval prompts")
    .action((name?: string) =>
      run(() =>
        import("@jazz/cli/commands/mcp").then((mod) => mod.trustMcpServerCommand(name, true)),
      ),
    );

  mcpCommand
    .command("untrust [name]")
    .description("Require approval for every tool call from a server")
    .action((name?: string) =>
      run(() =>
        import("@jazz/cli/commands/mcp").then((mod) => mod.trustMcpServerCommand(name, false)),
      ),
    );

  mcpCommand
    .command("auth <name>")
    .description("Authorize a remote MCP server in your browser (OAuth 2.1)")
    .action((name: string) =>
      run(() => import("@jazz/cli/commands/mcp").then((mod) => mod.authMcpServerCommand(name))),
    );

  mcpCommand
    .command("logout <name>")
    .description("Forget stored OAuth credentials for a remote MCP server")
    .action((name: string) =>
      run(() => import("@jazz/cli/commands/mcp").then((mod) => mod.logoutMcpServerCommand(name))),
    );
}

/**
 * Register persona-related commands
 */
function registerPersonaCommands(program: Command): void {
  const personaCommand = program.command("persona").description("Manage personas");

  function run(
    loadEffect: () => Promise<CliCommandEffect>,
    options?: CliRunOptions,
  ): Promise<void> {
    return runCliAction(loadEffect, cliRuntimeOptions(program), options);
  }

  personaCommand
    .command("create")
    .description("Create a new custom persona (interactive)")
    .action(() =>
      run(() => import("@jazz/cli/commands/persona").then((mod) => mod.createPersonaCommand()), {
        session: true,
      }),
    );

  personaCommand
    .command("list")
    .alias("ls")
    .description("List all personas (built-in + custom)")
    .action(() =>
      run(() => import("@jazz/cli/commands/persona").then((mod) => mod.listPersonasCommand())),
    );

  personaCommand
    .command("show <identifier>")
    .description("Show details of a persona by name or ID")
    .action((identifier: string) =>
      run(() =>
        import("@jazz/cli/commands/persona").then((mod) => mod.showPersonaCommand(identifier)),
      ),
    );

  personaCommand
    .command("edit <identifier>")
    .description("Edit an existing custom persona")
    .action((identifier: string) =>
      run(
        () =>
          import("@jazz/cli/commands/persona").then((mod) => mod.editPersonaCommand(identifier)),
        {
          session: true,
        },
      ),
    );

  personaCommand
    .command("delete <identifier>")
    .alias("rm")
    .description("Delete a custom persona")
    .action((identifier: string) =>
      run(() =>
        import("@jazz/cli/commands/persona").then((mod) => mod.deletePersonaCommand(identifier)),
      ),
    );
}

/**
 * Register update command
 */
function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .alias("upgrade")
    .description("Update Jazz to the latest version")
    .option("--check", "Check for updates without installing")
    .action((options: { check?: boolean }) =>
      runCliAction(
        () => import("@jazz/cli/commands/update").then((mod) => mod.updateCommand(options)),
        cliRuntimeOptions(program),
      ),
    );
}

/**
 * Register `jazz runs` — find and answer runs that stopped for a person.
 */
/**
 * Register `jazz peers` — who else's agent this machine will talk to.
 *
 * A peer is added by editing the config file, not by a command. Deliberate: the decision
 * worth making carefully is the tier, and someone choosing it should be looking at the file
 * rather than at a flag. What the commands own is the part that must not touch disk in
 * plaintext (the token) and the part worth reading back (the ledger).
 */
/**
 * Register `jazz daemon` — the long-lived HTTP server.
 *
 * One command, in the foreground. Supervision belongs to whatever already supervises this
 * host: the bridge ships as a container, scheduled workflows use launchd. A daemon that
 * forked and wrote a pidfile would be a third mechanism competing with both.
 */
function registerDaemonCommand(program: Command): void {
  const daemonCommand = program
    .command("daemon")
    .description(
      "Serve runs over HTTP so a parked run can be answered later, and from somewhere else",
    )
    .option("--port <n>", "Port to listen on", parsePositiveInt("--port"), 4747)
    .option(
      "--host <address>",
      "Interface to bind. Anything other than loopback requires a daemon token (env or keyring).",
      "127.0.0.1",
    )
    .option(
      "--serve-peers <agentId>",
      "Also answer questions from configured peers, using this agent. Off unless given: a daemon for your own use should not quietly answer strangers.",
    )
    .action((options: { port: number; host: string; servePeers?: string }) =>
      // No `{ session: true }` — that opts into the fullscreen alternate-screen TUI, meant
      // for commands a human actively drives (agent create/edit, chat, persona edit). A
      // daemon is long-running but headless: it logs plain lines to stderr and blocks,
      // exactly like every other non-interactive command that leaves this option off.
      runCliAction(
        () =>
          import("@jazz/cli/commands/daemon").then((mod) =>
            mod.daemonCommand({
              port: options.port,
              host: options.host,
              ...(options.servePeers !== undefined ? { peerAgent: options.servePeers } : {}),
            }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  daemonCommand
    .command("set-token")
    .description(
      "Generate and store a daemon bearer token in the OS keyring, or store $JAZZ_DAEMON_TOKEN if set",
    )
    .action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/daemon").then((mod) => mod.setDaemonTokenCommand()),
        cliRuntimeOptions(program),
      ),
    );

  daemonCommand
    .command("forget-token")
    .description("Remove the daemon's stored token")
    .action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/daemon").then((mod) => mod.forgetDaemonTokenCommand()),
        cliRuntimeOptions(program),
      ),
    );

  daemonCommand
    .command("install")
    .description(
      "Install this as a persistent system service (systemd on Linux, launchd on macOS) so it survives reboots and closed sessions. Needs root.",
    )
    .option("--yes", "Skip the confirmation prompt")
    .action((options: { yes?: boolean }) => {
      // `daemon` is both a runnable command and the parent of `install`. Commander assigns
      // duplicate option names to the parent, so defining --serve-peers/--host/--port again
      // here makes `daemon install --serve-peers …` fail its child's required-option check.
      // Read the parent's options instead: Commander accepts them after `install`, which keeps
      // the documented command shape while having one owner for each option.
      const daemonOptions = daemonCommand.opts<{
        readonly servePeers?: string | undefined;
        readonly host: string;
        readonly port: number;
      }>();
      if (daemonOptions.servePeers === undefined) {
        process.stderr.write("error: required option '--serve-peers <agentId>' not specified\n");
        process.exitCode = 1;
        return;
      }
      const agentId = daemonOptions.servePeers;
      return runCliAction(
        () =>
          import("@jazz/cli/commands/daemon").then((mod) =>
            mod.installDaemonServiceCommand({
              agentId,
              host: daemonOptions.host,
              port: daemonOptions.port,
              yes: options.yes === true,
            }),
          ),
        cliRuntimeOptions(program),
      );
    });

  daemonCommand
    .command("uninstall")
    .description("Remove the persistent system service installed by `daemon install`. Needs root.")
    .option("--yes", "Skip the confirmation prompt")
    .action((options: { yes?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/daemon").then((mod) =>
            mod.uninstallDaemonServiceCommand({ yes: options.yes === true }),
          ),
        cliRuntimeOptions(program),
      ),
    );
}

/**
 * Register `jazz wake-trigger fire` — internal, invoked by the host scheduler (launchd/`at`)
 * when a wake trigger's `fireAt` arrives, not meant for interactive use. Named `wake-trigger`
 * rather than `trigger`: the inbound HTTP feature that used to share the word is now called
 * `webhook` (`daemon.ts`, `appConfig.webhooks`), leaving "trigger" to mean only this.
 */
function registerWakeTriggerCommand(program: Command): void {
  const wakeTriggerCommand = program
    .command("wake-trigger")
    .description("Internal: commands invoked by the host scheduler for self-registered wake-ups");

  wakeTriggerCommand
    .command("fire")
    .description(
      "Internal: fire a specific wake trigger (invoked by the OS scheduler, not meant for interactive use)",
    )
    .requiredOption("--agent <agentId>", "Agent id the trigger belongs to")
    .requiredOption("--id <id>", "Wake trigger id")
    .action((options: { agent: string; id: string }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/wake-trigger").then((mod) =>
            mod.fireWakeTriggerCommand(options),
          ),
        cliRuntimeOptions(program),
      ),
    );
}

/**
 * Register `jazz reminder fire` — internal, invoked by the host scheduler (launchd/`at`) when a
 * reminder's `fireAt` arrives, not meant for interactive use. Sibling of `wake-trigger fire`:
 * both are one-shot OS-job firings, but this one sends a desktop notification instead of
 * resuming a conversation.
 */
function registerReminderCommand(program: Command): void {
  const reminderCommand = program
    .command("reminder")
    .description("Internal: commands invoked by the host scheduler for self-registered reminders");

  reminderCommand
    .command("fire")
    .description(
      "Internal: fire a specific reminder (invoked by the OS scheduler, not meant for interactive use)",
    )
    .requiredOption("--agent <agentId>", "Agent id the reminder belongs to")
    .requiredOption("--id <id>", "Reminder id")
    .action((options: { agent: string; id: string }) =>
      runCliAction(
        () => import("@jazz/cli/commands/reminder").then((mod) => mod.fireReminderCommand(options)),
        cliRuntimeOptions(program),
      ),
    );
}

function registerPeersCommands(program: Command): void {
  const peersCommand = program
    .command("peers")
    .description("Other people's agents this machine talks to, and what they have been told");

  peersCommand
    .command("list")
    .alias("ls")
    .description("List configured peers and what each may learn")
    .option("--json", "Emit a single JSON envelope { ok, peers }")
    .action((options: { json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peers").then((mod) =>
            mod.listPeersCommand({ json: options.json === true }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  peersCommand
    .command("set-token <name>")
    .description(
      "Store a peer's bearer token in the OS keyring, read from an environment variable so it never reaches your shell history",
    )
    .option("--from-env <VAR>", "Environment variable holding the token", "JAZZ_PEER_TOKEN")
    .action((name: string, options: { fromEnv: string }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peers").then((mod) =>
            mod.setPeerTokenCommand({ name, envVar: options.fromEnv }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  peersCommand
    .command("forget-token <name>")
    .description("Remove a peer's stored token")
    .action((name: string) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peers").then((mod) => mod.forgetPeerTokenCommand({ name })),
        cliRuntimeOptions(program),
      ),
    );

  peersCommand
    .command("log")
    .description("Everything said to and by a peer, newest first")
    .option("--peer <name>", "Only entries for this peer")
    .option("--limit <n>", "How many entries to show", parsePositiveInt("--limit"), 50)
    .option("--json", "Emit a single JSON envelope { ok, entries }")
    .option("-f, --follow", "Keep watching and print new entries as they land")
    .action((options: { peer?: string; limit: number; json?: boolean; follow?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peers").then((mod) =>
            mod.peerLogCommand({
              json: options.json === true,
              limit: options.limit,
              follow: options.follow === true,
              ...(options.peer !== undefined ? { peer: options.peer } : {}),
            }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  registerPeerInviteCommands(peersCommand, program);
}

/**
 * `jazz peers invite ...` — bootstrapping a peer relationship without a shared secret typed
 * by a human. Nested under `peersCommand` rather than a sibling top-level command: an invite
 * is not a new kind of thing, it is the setup path for the peers this group already manages.
 */
function registerPeerInviteCommands(peersCommand: Command, program: Command): void {
  const inviteCommand = peersCommand
    .command("invite")
    .description("Create and accept bootstrap links so two agents can become peers");

  inviteCommand
    .command("create <name>")
    .description(
      "Create a one-time invite link that grants <name> a tier once they accept it. " +
        "<name> is your own bookkeeping — the name you'll call them under afterward.",
    )
    .requiredOption(
      "--disclosure <tier>",
      `What the invitee may learn once they accept: ${PEER_TIERS.join(", ")}`,
    )
    .option(
      "--expires <duration>",
      "How long the link stays redeemable, e.g. 30m, 24h, 7d",
      parseDurationMs("--expires"),
      24 * 60 * 60 * 1000,
    )
    .option(
      "--host <address>",
      "Interface your daemon answers on — must match how you're running (or will run) `jazz daemon`",
      "127.0.0.1",
    )
    // 4747 mirrors `jazz daemon`'s own default (`DEFAULT_DAEMON_PORT`) — kept as a literal
    // here rather than a static import, matching this file's lazy-import convention for
    // command modules.
    .option("--port <n>", "Port your daemon answers on", parsePositiveInt("--port"), 4747)
    .option(
      "--as <name>",
      "What to call yourself to the invitee. Defaults to this machine's hostname.",
    )
    .option(
      "--persona <name>",
      "Which persona answers this invitee once accepted. Defaults to your daemon's --serve-peers agent as-is.",
    )
    .option(
      "--public-url <base>",
      "Overrides --host/--port for the printed link, e.g. https://bob-agent.example.com — " +
        "needed when the daemon binds loopback behind a reverse proxy, so the invite points " +
        "at what a redeemer can actually reach rather than the daemon's own bind address.",
    )
    .option("--qr", "Also print the link as a terminal QR code")
    .option("--json", "Emit a single JSON envelope { ok, id, url, expiresAt }")
    .action(
      (
        name: string,
        options: {
          disclosure: string;
          expires: number;
          host: string;
          port: number;
          publicUrl?: string;
          as?: string;
          persona?: string;
          qr?: boolean;
          json?: boolean;
        },
      ) =>
        runCliAction(
          () =>
            import("@jazz/cli/commands/peer-invites").then((mod) => {
              if (!isPeerTier(options.disclosure)) {
                throw new Error(
                  `--disclosure must be one of: ${PEER_TIERS.join(", ")} (got "${options.disclosure}")`,
                );
              }
              return mod.createInviteCommand({
                inviteeName: name,
                disclosure: options.disclosure,
                ttlMs: options.expires,
                host: options.host,
                port: options.port,
                json: options.json === true,
                qr: options.qr === true,
                ...(options.as !== undefined ? { as: options.as } : {}),
                ...(options.persona !== undefined ? { persona: options.persona } : {}),
                ...(options.publicUrl !== undefined ? { publicUrl: options.publicUrl } : {}),
              });
            }),
          cliRuntimeOptions(program),
        ),
    );

  inviteCommand
    .command("accept <url>")
    .description("Accept an invite link and become a peer of whoever sent it")
    .option("--as <name>", "What to call them locally. Defaults to the name they invited you as.")
    .option("--yes", "Skip the confirmation prompt")
    .option("--json", "Emit a single JSON envelope { ok, name }")
    .action((url: string, options: { as?: string; yes?: boolean; json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peer-invites").then((mod) =>
            mod.acceptInviteCommand({
              url,
              yes: options.yes === true,
              json: options.json === true,
              ...(options.as !== undefined ? { as: options.as } : {}),
            }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  inviteCommand
    .command("list")
    .alias("ls")
    .description("Invites created on this machine")
    .option("--json", "Emit a single JSON envelope { ok, invites }")
    .action((options: { json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peer-invites").then((mod) =>
            mod.listInvitesCommand({ json: options.json === true }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  inviteCommand
    .command("revoke <id>")
    .description("Invalidate an invite before anyone redeems it")
    .action((id: string) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/peer-invites").then((mod) => mod.revokeInviteCommand({ id })),
        cliRuntimeOptions(program),
      ),
    );
}

function registerRunsCommands(program: Command): void {
  const runsCommand = program
    .command("runs")
    .description("Inspect runs still in flight, and answer the ones waiting on you");

  runsCommand
    .command("list")
    .alias("ls")
    .description("List runs that have not finished, newest first")
    .option("--agent <agentId>", "Only runs belonging to this agent")
    .option("--conversation <id>", "Only runs from this conversation")
    .option(
      "--all",
      "Include runs that already finished, with what they cost. Records are kept for 7 days.",
    )
    .option("--json", "Emit a single JSON envelope { ok, runs }")
    .action((options: { agent?: string; conversation?: string; all?: boolean; json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/run/lifecycle").then((mod) =>
            mod.listRunsCommand({
              json: options.json === true,
              ...(options.agent !== undefined ? { agentId: options.agent } : {}),
              ...(options.conversation !== undefined
                ? { conversationId: options.conversation }
                : {}),
              ...(options.all === true ? { all: true } : {}),
            }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  runsCommand
    .command("show <runId>")
    .description("Show one run, including what it is waiting for")
    .option("--json", "Emit a single JSON envelope { ok, run }")
    .action((runId: string, options: { json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/run/lifecycle").then((mod) =>
            mod.showRunCommand({ runId, json: options.json === true }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  runsCommand
    .command("approve <runId>")
    .description(
      "Approve what a parked run is waiting for and let it finish (blocks until it does)",
    )
    .option("--json", "Emit a single JSON envelope { ok, runId, answer }")
    .action((runId: string, options: { json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/run/lifecycle").then((mod) =>
            mod.answerRunCommand({ runId, approved: true, json: options.json === true }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  runsCommand
    .command("reject <runId>")
    .description(
      "Refuse what a parked run is waiting for; it resumes and reasons about the refusal",
    )
    .option("--note <text>", "Tell the agent why, so it can try something else")
    .option("--json", "Emit a single JSON envelope { ok, runId, answer }")
    .action((runId: string, options: { note?: string; json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/run/lifecycle").then((mod) =>
            mod.answerRunCommand({
              runId,
              approved: false,
              json: options.json === true,
              ...(options.note !== undefined ? { note: options.note } : {}),
            }),
          ),
        cliRuntimeOptions(program),
      ),
    );

  runsCommand
    .command("cancel <runId>")
    .description("Abandon a parked run without answering it")
    .option("--json", "Emit a single JSON envelope { ok, runId }")
    .action((runId: string, options: { json?: boolean }) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/run/lifecycle").then((mod) =>
            mod.cancelRunCommand({ runId, json: options.json === true }),
          ),
        cliRuntimeOptions(program),
      ),
    );
}

/**
 * Register workflow-related commands
 */
function registerWorkflowCommands(program: Command): void {
  const workflowCommand = program.command("workflow").description("Manage and run workflows");

  workflowCommand
    .command("list")
    .alias("ls")
    .description("List all available workflows")
    .action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/workflow").then((mod) => mod.listWorkflowsCommand()),
        cliRuntimeOptions(program),
      ),
    );

  workflowCommand
    .command("show <name>")
    .description("Show details of a workflow")
    .action((name: string) =>
      runCliAction(
        () => import("@jazz/cli/commands/workflow").then((mod) => mod.showWorkflowCommand(name)),
        cliRuntimeOptions(program),
      ),
    );

  workflowCommand
    .command("run <name>")
    .description("Run a workflow once")
    .option("--auto-approve", "Auto-approve tool executions based on workflow policy")
    .option("--agent <agentId>", "Agent ID or name to use for this workflow run")
    .option(
      "--max-iterations <n>",
      "Maximum agent reasoning iterations (overrides the workflow's own setting)",
      parsePositiveInt("--max-iterations"),
    )
    .option(
      "--max-cost-usd <dollars>",
      "Spend ceiling in USD, checked between iterations (overrides the workflow's own setting)",
      parsePositiveFloat("--max-cost-usd"),
    )
    .option(
      "--max-tokens <n>",
      "Token ceiling, checked between iterations (overrides the workflow's own setting)",
      parsePositiveInt("--max-tokens"),
    )
    .option(
      "--max-duration-ms <ms>",
      "Wall-clock budget in ms with 50/80/90% pressure nudges to the agent, checked between iterations (overrides the workflow's own setting). Distinct from --timeout: that is a hard external kill with no warning.",
      parsePositiveInt("--max-duration-ms"),
    )
    .option(
      "--scheduled",
      "Indicates this run was triggered by the system scheduler (launchd/cron)",
    )
    .option(
      "--json",
      "Emit a single JSON envelope { ok, answer, costUSD, tokenUsage, toolCalls } on stdout (for scripts/gateways); all chatter is suppressed",
    )
    .option(
      "--timeout <ms>",
      "Abort the run after this many milliseconds",
      parsePositiveInt("--timeout"),
    )
    .option(
      "--events <categories>",
      "With --json: emit selected event categories as NDJSON to stderr during the run (comma-separated: tools,reasoning,text,usage,approval,subagent,all). stdout stays the clean payload.",
    )
    .option(
      "--stream",
      "Force streaming mode. Required for --events to emit reasoning and text in non-TTY contexts (CI, containers), where streaming is otherwise auto-disabled and only tool events survive.",
    )
    .option("--no-stream", "Disable streaming mode")
    .action(
      (
        name: string,
        options: {
          autoApprove?: boolean;
          agent?: string;
          maxIterations?: number;
          maxCostUsd?: number;
          maxTokens?: number;
          maxDurationMs?: number;
          scheduled?: boolean;
          json?: boolean;
          timeout?: number;
          events?: string;
          stream?: boolean;
          noStream?: boolean;
        },
        command: Command,
      ) => {
        const json = options.json === true;
        const isWorkflowRunCommand =
          command.name() === "run" && command.parent?.name() === "workflow";

        // Only the one-shot presentation layer (json mode) can emit NDJSON
        // events; in interactive mode --events would be silently ignored.
        if (options.events !== undefined && !json) {
          process.stderr.write("--events requires --json.\n");
          process.exitCode = 1;
          return;
        }

        const eventCategories =
          options.events !== undefined ? parseEventCategories(options.events) : undefined;
        if (eventCategories !== undefined && !eventCategories.ok) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: eventCategories.error, costUSD: 0 })}\n`,
          );
          process.exitCode = 1;
          return;
        }

        if (json) {
          // Force plain terminal so Ink never mounts and writes to stdout; the
          // one-shot presentation layer keeps stdout clean for the payload.
          process.env["JAZZ_NO_TUI"] = "1";
        }

        return runCliAction(
          () =>
            import("@jazz/cli/commands/workflow").then((mod) =>
              mod.runWorkflowCommand(name, {
                ...options,
                ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
                ...(options.maxCostUsd !== undefined ? { maxCostUSD: options.maxCostUsd } : {}),
                ...(eventCategories?.ok ? { eventTypes: eventCategories.types } : {}),
                ...resolveStreamOption(options, eventCategories),
              }),
            ),
          cliRuntimeOptions(program),
          { skipCatchUp: isWorkflowRunCommand, skipUpdateCheck: json, session: true },
        );
      },
    );

  workflowCommand
    .command("schedule <name>")
    .description("Enable scheduled execution for a workflow")
    .action((name: string) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/workflow").then((mod) => mod.scheduleWorkflowCommand(name)),
        cliRuntimeOptions(program),
      ),
    );

  workflowCommand
    .command("unschedule <name>")
    .description("Disable scheduled execution for a workflow")
    .action((name: string) =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/workflow").then((mod) => mod.unscheduleWorkflowCommand(name)),
        cliRuntimeOptions(program),
      ),
    );

  workflowCommand
    .command("scheduled")
    .description("List all scheduled workflows")
    .action(() =>
      runCliAction(
        () =>
          import("@jazz/cli/commands/workflow").then((mod) => mod.listScheduledWorkflowsCommand()),
        cliRuntimeOptions(program),
      ),
    );

  workflowCommand
    .command("catchup")
    .description("List workflows that missed a scheduled run, select which to run, then run them")
    .action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/workflow").then((mod) => mod.catchupWorkflowCommand()),
        cliRuntimeOptions(program),
        { session: true },
      ),
    );

  workflowCommand
    .command("history [name]")
    .description("Show workflow run history")
    .action((name?: string) =>
      runCliAction(
        () => import("@jazz/cli/commands/workflow").then((mod) => mod.workflowHistoryCommand(name)),
        cliRuntimeOptions(program),
      ),
    );
}

/**
 * Create and configure the CLI application
 *
 * Sets up the Commander.js program with all available commands including:
 * - Agent management (create, list, get, edit, delete, chat)
 * - Configuration management (get, set, show)
 * - MCP server management
 * - Update command
 */
export function createCLIApp(): Command {
  const program = new Command();

  program
    .name("jazz")
    .description(
      "Create and manage autonomous AI agents that execute real-world tasks (email, git, web, shell, and more)",
    )
    .version(packageJson.version);

  program
    .option("-v, --verbose", "Enable verbose logging")
    .option("--debug", "Enable debug level logging")
    .option("--config <path>", "Path to configuration file")
    .option(
      "--data-dir <path>",
      "Directory holding this invocation's config, data, and keyring entries " +
        "(overrides $JAZZ_HOME; defaults to ~/.jazz). Lets one host run several " +
        "independent agents by flag instead of by exporting JAZZ_HOME first.",
    )
    .option("--no-tui", "Disable TUI; use plain terminal output (for CI, scripts, small terminals)")
    .option(
      "--output <mode>",
      "Output mode: rendered, hybrid (default), raw (no formatting), or quiet (suppress output)",
    );

  program.hook("preAction", (thisCommand, actionCommand) => {
    const opts = thisCommand.optsWithGlobals();
    if (opts["tui"] === false) {
      process.env["JAZZ_NO_TUI"] = "1";
    }
    if (opts["output"]) {
      process.env["JAZZ_OUTPUT_MODE"] = opts["output"] as string;
    }
    if (opts["dataDir"]) {
      process.env["JAZZ_HOME"] = path.resolve(opts["dataDir"] as string);
    }
    setCurrentCommandName(commandPath(actionCommand));
  });

  registerRunCommand(program);
  registerAgentCommands(program);
  registerPersonaCommands(program);
  registerConfigCommands(program);
  registerMCPCommands(program);
  registerUpdateCommand(program);
  registerDaemonCommand(program);
  registerWakeTriggerCommand(program);
  registerReminderCommand(program);
  registerPeersCommands(program);
  registerRunsCommands(program);
  registerWorkflowCommands(program);

  if (process.argv.length <= 2) {
    program.action(() =>
      runCliAction(
        () => import("@jazz/cli/commands/wizard").then((mod) => mod.wizardCommand()),
        cliRuntimeOptions(program),
        { session: true },
      ),
    );
  }

  return program;
}

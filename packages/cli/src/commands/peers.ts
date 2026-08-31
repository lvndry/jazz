/**
 * @fileoverview `jazz peers` — who else's agent this machine will talk to.
 *
 * Nothing here serves a request or makes one; that arrives later. What these commands give
 * you is the ability to say who a peer is, what they may learn, and — the part worth having
 * before anything talks — to read back everything that has been said.
 */

import { read as readLedger } from "@jazz/adapters/peers/ledger";
import {
  describeKeyringBackend,
  detectKeyringBackend,
  keyringDelete,
  keyringSet,
} from "@jazz/adapters/secrets/keyring";
import { KEYRING_SERVICE_NAME, peerTokenPath } from "@jazz/adapters/secrets/registry";
import { AgentConfigServiceTag, type AgentConfigService } from "@jazz/core/interfaces/agent-config";
import { getErrorMessage } from "@jazz/core/presentation/error-handler";
import { isPeerTier, PEER_TIERS, type PeerConfig, type PeerTier } from "@jazz/core/types/peer";
import { Effect } from "effect";

/** Collapsed to one line so a multi-line answer cannot make the log unscannable. */
function oneLine(text: string, max = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function describeTier(tier: PeerTier | undefined): string {
  switch (tier ?? "none") {
    case "none":
      return "nothing (suspended)";
    case "public":
      return "nothing about you";
    case "internal":
      return "the shape of your machine";
    case "private":
      return "anything readable";
  }
}

function configuredPeers(): Effect.Effect<readonly PeerConfig[], Error, AgentConfigService> {
  return Effect.gen(function* () {
    const configService = yield* AgentConfigServiceTag;
    const appConfig = yield* configService.appConfig;
    return appConfig.peers ?? [];
  });
}

export function listPeersCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const peers = yield* configuredPeers();

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, peers })}\n`);
      return;
    }
    if (peers.length === 0) {
      process.stdout.write("No peers configured.\n");
      return;
    }
    for (const peer of peers) {
      const url = peer.url ?? "(cannot be asked — no endpoint)";
      const persona = peer.persona !== undefined ? `  persona: ${peer.persona}` : "";
      const allow =
        peer.allow !== undefined && peer.allow.length > 0
          ? `  allow: ${peer.allow.join(", ")}`
          : "";
      process.stdout.write(
        `${peer.name}  ${url}  may learn: ${describeTier(peer.disclosure)}${persona}${allow}\n`,
      );
    }
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`${getErrorMessage(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

/**
 * Store a peer's token.
 *
 * The token is read from an environment variable rather than an argument, so it never
 * reaches the shell history of the person adding it. The peer itself still has to be added
 * to the config file by hand — deliberately, for now: writing config from a command is a
 * separate concern, and the interesting decision here is the tier, which someone should be
 * looking at the file to make.
 */
export function setPeerTokenCommand(options: { readonly name: string; readonly envVar: string }) {
  return Effect.gen(function* () {
    const token = process.env[options.envVar];
    if (token === undefined || token.trim().length === 0) {
      process.stderr.write(
        `No token found in $${options.envVar}. Set it in the environment and run this again.\n`,
      );
      process.exitCode = 1;
      return;
    }

    const backend = yield* detectKeyringBackend();
    if (backend === "none") {
      process.stderr.write(
        "$JAZZ_DISABLE_KEYRING is set, so Jazz won't store this token anywhere — unset it and " +
          "run this again, or persist the token yourself (a systemd `Environment=` line, your " +
          "shell profile).\n",
      );
      process.exitCode = 1;
      return;
    }

    const stored = yield* keyringSet(backend, peerTokenPath(options.name), token);
    if (!stored) {
      process.stderr.write(
        `Could not store the token for "${options.name}" — neither the OS keyring nor the ` +
          `$JAZZ_HOME/secrets.json fallback could be written to. Check that $JAZZ_HOME is ` +
          `actually writable.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `Stored a token for "${options.name}" in ${describeKeyringBackend(backend)}.\n`,
    );
  });
}

export function forgetPeerTokenCommand(options: { readonly name: string }) {
  return Effect.gen(function* () {
    const backend = yield* detectKeyringBackend();
    yield* keyringDelete(backend, peerTokenPath(options.name));
    process.stdout.write(
      `Removed any stored token for "${options.name}". Remove the peer from your config to stop talking to it entirely.\n`,
    );
  });
}

export function peerLogCommand(options: {
  readonly json: boolean;
  readonly peer?: string;
  readonly limit: number;
}) {
  return Effect.gen(function* () {
    const entries = yield* readLedger({
      limit: options.limit,
      ...(options.peer !== undefined ? { peer: options.peer } : {}),
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, entries })}\n`);
      return;
    }
    if (entries.length === 0) {
      process.stdout.write("Nothing has been said to or by a peer.\n");
      return;
    }
    for (const entry of entries) {
      const arrow = entry.direction === "out" ? "->" : "<-";
      const detail = entry.reason !== undefined ? ` (${entry.reason})` : "";
      const tier = entry.tier !== undefined ? `  tier=${entry.tier}` : "";
      process.stdout.write(
        `${entry.at}  ${arrow} ${entry.peer}  ${entry.outcome}${detail}${tier}\n` +
          `    asked: ${oneLine(entry.question)}\n` +
          // The answer is shown, not just the outcome. A question the tier defeated is still
          // "answered" — the agent replied "I cannot" — so outcome alone cannot tell a
          // refused probe from a benign question, and telling those apart is the entire
          // reason this record exists.
          (entry.answer !== undefined ? `    said:  ${oneLine(entry.answer)}\n` : ""),
      );
    }
  });
}

export { KEYRING_SERVICE_NAME, PEER_TIERS, isPeerTier, describeTier };

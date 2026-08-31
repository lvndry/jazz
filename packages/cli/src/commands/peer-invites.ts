/**
 * @fileoverview `jazz peers invite` — becoming peers without a human ever typing a shared
 * secret.
 *
 * `create`, `list`, and `revoke` are plain local file operations: the inviter already has a
 * shell on the machine whose invite store and config they are changing, so there is no
 * network round-trip to make here — the same reasoning `jazz peers log` uses to read the
 * ledger straight off disk. Only `accept` ever crosses the network, because only the
 * redeemer is, by construction, on a different machine.
 */

import * as os from "node:os";
import { upsertPeer } from "@jazz/adapters/peers/config";
import {
  createInvite,
  getInvitesDirectory,
  listInvites,
  revokeInvite,
} from "@jazz/adapters/peers/invites";
import { detectKeyringBackend, keyringSet } from "@jazz/adapters/secrets/keyring";
import { peerTokenPath } from "@jazz/adapters/secrets/registry";
import { PersonaServiceTag } from "@jazz/core/interfaces/persona-service";
import { TerminalServiceTag } from "@jazz/core/interfaces/terminal";
import { getErrorMessage } from "@jazz/core/presentation/error-handler";
import { CLIError } from "@jazz/core/types/errors";
import { isPeerTier, PEER_TIERS, type PeerTier } from "@jazz/core/types/peer";
import { inviteStatus, isInviteId } from "@jazz/core/types/peer-invite";
import { Effect } from "effect";
import { generate as generateQrCode } from "qrcode-terminal";
import { describeTier } from "./peers";

function renderQrCode(text: string): Promise<string> {
  return new Promise((resolve) => {
    generateQrCode(text, { small: true }, resolve);
  });
}

/**
 * Loopback, RFC1918 LAN ranges, and Tailscale's CGNAT range (`100.64.0.0/10`) plus MagicDNS
 * names — every host `docs/guide/peers-setup.md` already documents as "no encryption needed"
 * because either nothing can intercept it (loopback) or the network itself already does the
 * encrypting (WireGuard). Anything else on plain HTTP is a genuinely new plaintext wire
 * transfer this feature introduces that manual `set-token` never had.
 */
function isEncryptedOrUnreachableNetwork(host: string): boolean {
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  const octets = host.split(".");
  const ipv4 =
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
      ? octets.map(Number)
      : undefined;
  if (ipv4?.[0] === 10) return true;
  if (ipv4?.[0] === 192 && ipv4[1] === 168) return true;
  if (ipv4?.[0] === 172 && ipv4[1] !== undefined && ipv4[1] >= 16 && ipv4[1] <= 31) return true;
  if (ipv4?.[0] === 100 && ipv4[1] !== undefined && ipv4[1] >= 64 && ipv4[1] <= 127) return true;
  if (host.endsWith(".ts.net")) return true;
  return false;
}

function plaintextWarning(host: string): string | undefined {
  if (isEncryptedOrUnreachableNetwork(host)) return undefined;
  return (
    "Warning: this endpoint is not loopback or a private/Tailscale network and uses plain " +
    "HTTP — the invite secret and the resulting peer token will cross the network " +
    "unencrypted. Prefer TLS (a reverse proxy) or a private network for this host.\n"
  );
}

function formatRelative(iso: string, now: Date): string {
  const diffMs = new Date(iso).getTime() - now.getTime();
  const past = diffMs <= 0;
  const totalMinutes = Math.round(Math.abs(diffMs) / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const label = hours > 0 ? `${String(hours)}h ${String(minutes)}m` : `${String(minutes)}m`;
  return past ? `${label} ago` : `in ${label}`;
}

export interface CreateInviteCommandOptions {
  readonly inviteeName: string;
  readonly disclosure: PeerTier;
  readonly ttlMs: number;
  readonly host: string;
  readonly port: number;
  /**
   * Overrides the constructed `http://host:port` origin for both the embedded ask URL and the
   * invite link itself. Needed whenever the daemon's bind address isn't what a redeemer can
   * actually reach — the reverse-proxy topology in docs/guide/peers-setup.md's "over the
   * internet" section is exactly this: the daemon stays on loopback, but the invite has to
   * point at the public domain the proxy fronts.
   */
  readonly publicUrl?: string;
  readonly as?: string;
  /** Which persona answers this invitee once accepted. Absent keeps the daemon's default. */
  readonly persona?: string;
  readonly json: boolean;
  readonly qr: boolean;
}

export function createInviteCommand(options: CreateInviteCommandOptions) {
  return Effect.gen(function* () {
    let origin = `http://${options.host}:${String(options.port)}`;
    if (options.publicUrl !== undefined) {
      let publicUrl: URL;
      try {
        publicUrl = new URL(options.publicUrl);
      } catch {
        return yield* Effect.fail(
          new CLIError({
            command: "peers invite create",
            message: "--public-url must be an absolute HTTP(S) URL",
          }),
        );
      }
      if (
        (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") ||
        publicUrl.pathname !== "/" ||
        publicUrl.search !== "" ||
        publicUrl.hash !== "" ||
        publicUrl.username !== "" ||
        publicUrl.password !== ""
      ) {
        return yield* Effect.fail(
          new CLIError({
            command: "peers invite create",
            message:
              "--public-url must be an HTTP(S) origin without a path, query, fragment, or credentials",
          }),
        );
      }
      origin = publicUrl.origin;
    }

    // Fail fast on a persona typo now, at the one point a human is actively watching —
    // otherwise it surfaces only when a peer actually asks a question, as an opaque refusal
    // this operator has to go dig out of `jazz peers log` to explain.
    if (options.persona !== undefined) {
      const personaService = yield* PersonaServiceTag;
      const resolved = yield* personaService
        .getPersonaByIdentifier(options.persona)
        .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
      if (resolved === undefined) {
        return yield* Effect.fail(
          new CLIError({
            command: "peers invite create",
            message: `No persona named "${options.persona}" exists.`,
            suggestion: "Run `jazz persona list` to see what's available, or create it first.",
          }),
        );
      }
    }

    const inviterAskUrl = `${origin}/peer/ask`;
    const created = yield* createInvite({
      inviteeName: options.inviteeName,
      inviterDisplayName: options.as ?? os.hostname(),
      inviterAskUrl,
      proposedTier: options.disclosure,
      ...(options.persona !== undefined ? { proposedPersona: options.persona } : {}),
      ttlMs: options.ttlMs,
    });

    const url = `${origin}/peer-invites/${created.record.id}#${created.secret}`;

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, id: created.record.id, url, expiresAt: created.record.expiresAt })}\n`,
      );
      return;
    }

    let originUrl: URL | undefined;
    try {
      originUrl = new URL(origin);
    } catch {
      originUrl = undefined;
    }
    const warning =
      originUrl !== undefined && originUrl.protocol === "https:"
        ? undefined
        : plaintextWarning(originUrl?.hostname ?? options.host);
    if (warning !== undefined) process.stderr.write(warning);

    process.stdout.write(
      `Created an invite for "${options.inviteeName}" — ${describeTier(options.disclosure)} ` +
        `(${options.disclosure}), expiring ${formatRelative(created.record.expiresAt, new Date())}.\n\n` +
        "Share this link (it embeds your endpoint and a one-time secret — send it somewhere " +
        "the recipient will actually see it, not a public channel):\n\n" +
        `  ${url}\n\n` +
        "This link is single-use and cannot be reused after it is accepted, or after it " +
        'expires. Nobody who does not have everything after the "#" can redeem it.\n',
    );

    if (options.qr) {
      const qr = yield* Effect.promise(() => renderQrCode(url));
      process.stdout.write(`\nQR:\n${qr}\n`);
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

export function listInvitesCommand(options: { readonly json: boolean }) {
  return Effect.gen(function* () {
    const invites = yield* listInvites();
    const now = new Date();

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          invites: invites.map((invite) => ({ ...invite, status: inviteStatus(invite, now) })),
        })}\n`,
      );
      return;
    }

    if (invites.length === 0) {
      process.stdout.write("No invites created on this machine.\n");
      return;
    }

    for (const invite of invites) {
      const status = inviteStatus(invite, now);
      const statusLabel =
        status === "active"
          ? `expires ${formatRelative(invite.expiresAt, now)}`
          : status === "expired"
            ? `expired ${formatRelative(invite.expiresAt, now)}`
            : status;
      process.stdout.write(
        `${invite.id}  ${invite.inviteeName}  ${invite.proposedTier}  ${statusLabel}\n`,
      );
    }
  });
}

export function revokeInviteCommand(options: { readonly id: string }) {
  return Effect.gen(function* () {
    if (!isInviteId(options.id)) {
      process.stderr.write(`"${options.id}" is not an invite id.\n`);
      process.exitCode = 1;
      return;
    }
    const revoked = yield* revokeInvite(options.id);
    if (!revoked) {
      process.stderr.write(
        "No active invite with that id — it may not exist, or is already used or revoked.\n",
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write("Revoked the invite. The link is now dead.\n");
  });
}

interface ParsedInviteUrl {
  readonly origin: string;
  readonly id: string;
  readonly secret: string;
}

function parseInviteUrl(raw: string): ParsedInviteUrl | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const match = /^\/peer-invites\/([^/]+)\/?$/.exec(url.pathname);
  const id = match?.[1];
  const secret = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  if (id === undefined || secret.length === 0) return undefined;
  return { origin: url.origin, id, secret };
}

interface InvitePreview {
  readonly inviterDisplayName: string;
  readonly inviterAskUrl: string;
  readonly proposedTier: PeerTier;
  readonly expiresAt: string;
  readonly status: "active" | "expired" | "redeemed" | "revoked";
}

function parsePreview(body: unknown): InvitePreview | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate["inviterDisplayName"] === "string" &&
    typeof candidate["inviterAskUrl"] === "string" &&
    typeof candidate["proposedTier"] === "string" &&
    isPeerTier(candidate["proposedTier"]) &&
    typeof candidate["expiresAt"] === "string" &&
    typeof candidate["status"] === "string"
  ) {
    return {
      inviterDisplayName: candidate["inviterDisplayName"],
      inviterAskUrl: candidate["inviterAskUrl"],
      proposedTier: candidate["proposedTier"],
      expiresAt: candidate["expiresAt"],
      status: candidate["status"] as InvitePreview["status"],
    };
  }
  return undefined;
}

function describeStatusFailure(status: InvitePreview["status"], expiresAt: string): string {
  switch (status) {
    case "expired":
      return `This invite has expired (it was valid until ${expiresAt}).`;
    case "redeemed":
      return "This invite has already been used and cannot be redeemed again.";
    case "revoked":
      return "This invite was revoked by its creator and is no longer valid.";
    case "active":
      return "";
  }
}

export interface AcceptInviteCommandOptions {
  readonly url: string;
  readonly as?: string;
  readonly yes: boolean;
  readonly json: boolean;
}

/**
 * Fetching the preview and posting the accept are both plain `fetch` calls to the inviter's
 * daemon, not Jazz's own agent stack — this command runs entirely on the redeemer's machine
 * and never needs an agent, a config service, or anything else beyond what it writes to its
 * own config and keyring at the end.
 */
export function acceptInviteCommand(options: AcceptInviteCommandOptions) {
  return Effect.gen(function* () {
    const parsed = parseInviteUrl(options.url);
    if (parsed === undefined) {
      return yield* Effect.fail(
        new CLIError({
          command: "peers invite accept",
          message: "that does not look like a peer invite link",
          suggestion:
            'Paste the whole link, including everything after "#" — the redeem secret lives there.',
        }),
      );
    }

    const previewResponse = yield* Effect.tryPromise({
      try: (): Promise<{ readonly status: number; readonly body: unknown }> =>
        fetch(`${parsed.origin}/peer-invites/${parsed.id}`).then(async (response) => ({
          status: response.status,
          body: (await response.json()) as unknown,
        })),
      catch: (error) => error,
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const previewError =
      previewResponse !== undefined &&
      typeof previewResponse.body === "object" &&
      previewResponse.body !== null &&
      typeof (previewResponse.body as Record<string, unknown>)["error"] === "string"
        ? (previewResponse.body as Record<string, unknown>)["error"]
        : undefined;
    if (previewResponse?.status === 404 && previewError === "not accepting peer invitations") {
      return yield* Effect.fail(
        new CLIError({
          command: "peers invite accept",
          message: "the inviter's daemon is running, but it is not serving peers",
          suggestion: "Ask the inviter to restart it with `jazz daemon --serve-peers <agent>`.",
        }),
      );
    }

    const preview = parsePreview(previewResponse?.body);
    if (preview === undefined) {
      return yield* Effect.fail(
        new CLIError({
          command: "peers invite accept",
          message: `could not reach ${parsed.origin}, or it has no such invite`,
          suggestion: "Check the link and that the inviter's daemon is running.",
        }),
      );
    }
    if (preview.status !== "active") {
      process.stderr.write(`${describeStatusFailure(preview.status, preview.expiresAt)}\n`);
      process.exitCode = 1;
      return;
    }

    const localName = options.as ?? preview.inviterDisplayName;
    const parsedUrl = new URL(parsed.origin);
    const warning =
      parsedUrl.protocol === "https:" ? undefined : plaintextWarning(parsedUrl.hostname);
    if (warning !== undefined) process.stderr.write(warning);

    const backend = yield* detectKeyringBackend();
    if (backend === "none") {
      return yield* Effect.fail(
        new CLIError({
          command: "peers invite accept",
          message:
            "$JAZZ_DISABLE_KEYRING is set, so there is nowhere to store the resulting peer token",
          suggestion:
            "Unset $JAZZ_DISABLE_KEYRING before accepting, so this single-use link is not spent.",
        }),
      );
    }

    if (!options.json) {
      process.stdout.write(
        `This invite is from "${preview.inviterDisplayName}", reachable at ${preview.inviterAskUrl}.\n` +
          `It grants you: ${describeTier(preview.proposedTier)} (${preview.proposedTier}).\n` +
          `Expires: ${preview.expiresAt} (${formatRelative(preview.expiresAt, new Date())}).\n`,
      );
    }

    if (!options.yes) {
      const terminal = yield* TerminalServiceTag;
      if (!terminal.isInteractive) {
        return yield* Effect.fail(
          new CLIError({
            command: "peers invite accept",
            message:
              "accepting an invite requires confirmation, but this session is not interactive",
            suggestion: "Pass --yes to accept without a confirmation prompt.",
          }),
        );
      }
      const confirmed = yield* terminal.confirm(`Accept and add "${localName}" as a peer?`, false);
      if (!confirmed) {
        process.stdout.write("Not accepted.\n");
        return;
      }
    }

    // Persist this side before consuming the single-use remote credential. If the local
    // config cannot be written, the user can fix storage and retry the same link.
    yield* upsertPeer({ name: localName, url: preview.inviterAskUrl });

    const acceptResponse = yield* Effect.tryPromise({
      try: (): Promise<{ readonly status: number; readonly body: unknown }> =>
        fetch(`${parsed.origin}/peer-invites/${parsed.id}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: parsed.secret, as: localName }),
        }).then(async (response) => ({
          status: response.status,
          body: (await response.json()) as unknown,
        })),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.succeed({
          status: 0,
          body: { ok: false, error: error instanceof Error ? error.message : String(error) },
        }),
      ),
    );

    const body = acceptResponse.body as { ok?: unknown; error?: unknown; token?: unknown };
    if (body.ok !== true || typeof body.token !== "string") {
      const message = typeof body.error === "string" ? body.error : "could not accept the invite";
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
      return;
    }

    const stored = yield* keyringSet(backend, peerTokenPath(localName), body.token);
    if (!stored) {
      process.stderr.write(
        "The invite was accepted, but Jazz could not store the token. Finish setup manually:\n" +
          `  JAZZ_PEER_TOKEN=${body.token} jazz peers set-token ${localName}\n`,
      );
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, name: localName })}\n`);
      return;
    }
    process.stdout.write(
      `Added "${localName}" as a peer and stored the shared token.\n` +
        `Try: jazz run --agent <yours> "ask ${localName}'s agent ..."\n`,
    );
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        process.stderr.write(`${getErrorMessage(error)}\n`);
        process.exitCode = 1;
      }),
    ),
  );
}

export { PEER_TIERS, getInvitesDirectory };

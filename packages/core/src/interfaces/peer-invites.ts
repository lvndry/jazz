import { Context, Effect } from "effect";
import type { PeerTier } from "@/core/types/peer";
import type { PeerInviteRecord, RedeemInviteOutcome } from "@/core/types/peer-invite";

export interface CreateInviteInput {
  readonly inviteeName: string;
  readonly inviterDisplayName: string;
  readonly inviterAskUrl: string;
  readonly proposedTier: PeerTier;
  readonly ttlMs: number;
}

export interface CreatedInvite {
  readonly record: PeerInviteRecord;
  /** The one-time redeem secret. Returned once, at creation, and never persisted. */
  readonly secret: string;
}

export interface RedeemInviteInput {
  readonly id: string;
  readonly secret: string;
}

/**
 * The invite lifecycle: create, inspect, redeem once, revoke.
 *
 * Deliberately narrow, the same way {@link PeerLedgerService} and {@link PeerTokenService}
 * are: this service owns whether an invite is still usable, nothing about what redeeming one
 * does to `AppConfig` or the keyring. Composing those effects is the caller's job — see
 * `acceptInviteOnInviterSide` in `@jazz/adapters/peers/invites`.
 */
export interface PeerInviteService {
  readonly create: (input: CreateInviteInput) => Effect.Effect<CreatedInvite, never>;
  readonly get: (id: string) => Effect.Effect<PeerInviteRecord | undefined, never>;
  readonly list: () => Effect.Effect<readonly PeerInviteRecord[], never>;
  /** True when an invite existed and was not already redeemed or revoked. */
  readonly revoke: (id: string) => Effect.Effect<boolean, never>;
  /**
   * Verify and, if valid, atomically mark an invite as redeemed.
   *
   * "Atomically" is the whole point: two requests racing to redeem the same invite must not
   * both observe it as valid. See the file-store implementation for how that is enforced
   * without a database.
   */
  readonly redeem: (
    input: RedeemInviteInput,
    redeemedAs: string,
  ) => Effect.Effect<RedeemInviteOutcome, never>;
}

export const PeerInviteServiceTag = Context.GenericTag<PeerInviteService>("PeerInviteService");

/**
 * @fileoverview The Photon side of the `Surface` contract.
 *
 * Rendering is the local bridge's, imported rather than rewritten: both end up
 * in the same Messages bubble. What differs is only how a message is delivered
 * - `space.send` over Photon's line instead of `imsg send` on your own Mac.
 */

import {
  IMESSAGE_CAPABILITIES,
  IMESSAGE_CHUNK_CHARS,
  renderForIMessage,
} from "@jazz/bot-shared/imessage-render";
import {
  type ChatId,
  type MessageRef,
  type OutgoingMessage,
  splitForSurface,
  type Surface,
} from "@jazz/bot-shared/surface";
import { attachment } from "spectrum-ts";

/** The half of a Spectrum space this surface uses. */
export interface PhotonSpace {
  send(content: unknown): Promise<unknown>;
}

export interface PhotonSurfaceOptions {
  /** Resolve a chat id back to the Spectrum space it came from. */
  readonly resolveSpace: (chatId: ChatId) => PhotonSpace | undefined;
}

export function createPhotonSurface(options: PhotonSurfaceOptions): Surface {
  return {
    name: "photon",
    // A hosted line reaches the same client, so it can do exactly what the
    // local bridge can: no editing, no buttons, no typing indicator.
    capabilities: IMESSAGE_CAPABILITIES,

    async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> {
      const space = options.resolveSpace(chatId);
      // A space we have never seen cannot be addressed: Photon's free tier
      // refuses to open a conversation the other person did not start.
      if (space === undefined) return undefined;

      for (const chunk of splitForSurface(renderForIMessage(message), IMESSAGE_CHUNK_CHARS)) {
        if (chunk.trim().length === 0) continue;
        await space.send(chunk);
      }
      return undefined;
    },

    async sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
      const space = options.resolveSpace(chatId);
      if (space === undefined) return;

      // A path rather than bytes: `attachment` reads it, and everything that
      // reaches here is already a file the agent wrote or was handed.
      await space.send(attachment(filePath));
      if (caption !== undefined && caption.trim().length > 0) await space.send(caption);
    },
  };
}

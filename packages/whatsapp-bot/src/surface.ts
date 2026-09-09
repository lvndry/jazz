/**
 * @fileoverview The WhatsApp side of the `Surface` contract.
 *
 * WhatsApp renders a small formatting dialect of its own — `*bold*`,
 * `_italic_`, `~strike~`, ```` ```monospace``` ```` and `>` quotes — which is
 * neither Markdown nor HTML, so `RichText` is rendered to it here.
 *
 * It is treated as append-only even though the protocol can edit a sent
 * message. An edited message is tagged "edited" in the client and edits are
 * both rate-limited and time-limited, so driving a progress bubble through them
 * would look broken and risk the connection. The core's append-only mode — one
 * acknowledgement, then the answer — is the right shape here.
 */

import {
  type ChatId,
  type MessageRef,
  type OutgoingMessage,
  renderChoicesAsText,
  splitForSurface,
  type Surface,
  type SurfaceCapabilities,
} from "@jazz/bot-shared/surface";
import type { Connection } from "./whatsapp";

/**
 * Where one outgoing message is cut.
 *
 * WhatsApp's own limit is far higher, but a long agent answer is easier to read
 * as a few messages than one that needs scrolling to reach its own start. This
 * matches the bound OpenClaw's WhatsApp channel uses for the same reason.
 */
const WHATSAPP_CHUNK_CHARS = 4_000;

const CAPABILITIES: SurfaceCapabilities = {
  editMessages: false,
  // Baileys can send interactive buttons, but WhatsApp has been progressively
  // restricting them to business accounts and they silently degrade to nothing
  // on a personal one — a prompt nobody can answer. Numbered replies always work.
  buttons: false,
  attachments: true,
  typingIndicator: true,
  maxMessageChars: WHATSAPP_CHUNK_CHARS,
};

export function renderForWhatsApp(message: OutgoingMessage): string {
  const rendered = message.body
    .map((block) => {
      switch (block.kind) {
        case "line":
          return block.spans
            .map((span) => {
              if (span.kind === "bold") return `*${span.text}*`;
              if (span.kind === "code") return `\`\`\`${span.text}\`\`\``;
              return span.text;
            })
            .join("");
        case "codeBlock":
          return `\`\`\`\n${block.text}\n\`\`\``;
        case "quote":
          return block.text
            .split("\n")
            .map((row) => `> ${row}`)
            .join("\n");
      }
    })
    .join("\n");

  if (message.choices === undefined || message.choices.length === 0) return rendered;
  return `${rendered}\n\n${renderChoicesAsText(message.choices)}\n\n_reply with a number_`;
}

export function createWhatsAppSurface(connection: Connection): Surface {
  return {
    name: "whatsapp",
    capabilities: CAPABILITIES,

    async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageRef | undefined> {
      for (const chunk of splitForSurface(renderForWhatsApp(message), WHATSAPP_CHUNK_CHARS)) {
        if (chunk.trim().length === 0) continue;
        await connection.send(chatId, chunk);
      }
      // Nothing in the core addresses a sent message again on an append-only
      // surface, so the ids Baileys returns are not tracked.
      return undefined;
    },

    sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
      return connection.sendFile(chatId, filePath, caption);
    },

    typing(chatId: ChatId): Promise<void> {
      return connection.typing(chatId);
    },
  };
}

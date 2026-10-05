/**
 * Which conversations an interactive chat has open right now, so the work that comes back to a
 * conversation later (a finished job batch, a due wake trigger) runs in that chat, where the
 * user sees it and answers its approvals, instead of as an unattended turn nobody is watching.
 *
 * One file per conversation at `$JAZZ_HOME/chat-attachments/<agentId>/<conversationId>.json`,
 * naming the chat's process. Reads and writes are synchronous: a delivery claim checks it under
 * a store's lock, from inside a pure selection, and the files are a few bytes each.
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { localOwnerStatus, currentProcessOwner, type ProcessOwner } from "@jazz/core/utils/process";
import { isValidStorageKey } from "@jazz/core/utils/storage";
import { isThisProcess } from "@/adapters/runs/runs-in-flight";

export function chatAttachmentDirectory(): string {
  return path.join(getJazzHomeDirectory(), "chat-attachments");
}

function attachmentPath(
  baseDirectory: string,
  agentId: string,
  conversationId: string,
): string | undefined {
  if (!isValidStorageKey(agentId) || !isValidStorageKey(conversationId)) {
    return undefined;
  }
  return path.join(baseDirectory, agentId, `${conversationId}.json`);
}

function readOwner(filePath: string): ProcessOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(nodeFs.readFileSync(filePath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ProcessOwner).pid === "number" &&
      typeof (parsed as ProcessOwner).host === "string"
    ) {
      return parsed as ProcessOwner;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Record that this process's chat has `conversationId` open. Never throws. */
export function attachChat(
  agentId: string,
  conversationId: string,
  baseDirectory: string = chatAttachmentDirectory(),
): void {
  const filePath = attachmentPath(baseDirectory, agentId, conversationId);
  if (filePath === undefined) {
    return;
  }
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    nodeFs.mkdirSync(path.dirname(filePath), { recursive: true });
    nodeFs.writeFileSync(temporaryPath, JSON.stringify(currentProcessOwner()));
    nodeFs.renameSync(temporaryPath, filePath);
  } catch {
    nodeFs.rmSync(temporaryPath, { force: true });
  }
}

/** Remove this process's attachment to `conversationId`; another chat's is left alone. */
export function detachChat(
  agentId: string,
  conversationId: string,
  baseDirectory: string = chatAttachmentDirectory(),
): void {
  const filePath = attachmentPath(baseDirectory, agentId, conversationId);
  if (filePath === undefined || !isThisProcess(readOwner(filePath))) {
    return;
  }
  nodeFs.rmSync(filePath, { force: true });
}

/**
 * Whether a live chat in another process has `conversationId` open, so its deliveries are that
 * chat's to run. A chat on another host cannot be checked from here and does not hold it.
 */
export function heldByChatElsewhere(
  agentId: string,
  conversationId: string,
  baseDirectory: string = chatAttachmentDirectory(),
): boolean {
  const filePath = attachmentPath(baseDirectory, agentId, conversationId);
  if (filePath === undefined) {
    return false;
  }
  const owner = readOwner(filePath);
  if (owner === undefined || isThisProcess(owner)) {
    return false;
  }
  return localOwnerStatus(owner) === "alive";
}

/**
 * A conversation log read as a tree: every message points at the one it follows, so a save only
 * ever adds, and nothing said is hidden by a later save.
 *
 * - A message's `parentId` is the entry it follows; `null` starts a root.
 * - A `context` entry says what the model sees from that point on: the messages its `keep` runs
 *   name, in order, then whatever follows the entry. Compaction and the history cap write one;
 *   the messages they leave out stay where they are.
 * - The leaf, where the conversation continues, is the last message or `context` entry in the
 *   file, or the entry a later `leaf` event names.
 *
 * Logs from before ids (version 3 and older) have messages in file order with `rewrite` markers.
 * They read as chains: a message without an id follows the message before it in the file, and
 * the first after a `rewrite` starts a new root. Their ids are derived from the conversation and
 * the message's position among the file's messages, so reading one and later upgrading it on disk
 * give every message the same id, and no two conversations share one.
 */
import { createHash, randomBytes } from "node:crypto";
import type { ChatMessage } from "@jazz/core/types/message";

/** A run of entries along parent links: `through`, then its parents up to and including `from`. */
export interface KeepRun {
  readonly from: string;
  readonly through: string;
}

export type ConversationTreeNode =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly parentId: string | null;
      readonly message: ChatMessage;
      readonly at: string;
    }
  | {
      readonly kind: "context";
      readonly id: string;
      readonly parentId: string | null;
      readonly keep: readonly KeepRun[];
    };

export interface ConversationTree {
  readonly nodes: ReadonlyMap<string, ConversationTreeNode>;
  readonly leafId: string | null;
}

/** The parts of log events the tree is built from. */
export type TreeEvent =
  | {
      readonly type: "message";
      readonly at: string;
      readonly message: ChatMessage;
      readonly id?: string;
      readonly parentId?: string | null;
    }
  | {
      readonly type: "context";
      readonly id: string;
      readonly parentId: string | null;
      readonly keep: readonly KeepRun[];
    }
  | { readonly type: "leaf"; readonly id: string | null }
  | { readonly type: "rewrite" }
  | { readonly type: "other" };

/** Characters of the conversation-id hash that make legacy ids unique across conversations. */
const LEGACY_ID_SALT_CHARS = 6;

/**
 * The id a message from before ids gets: its conversation, then its position among the file's
 * messages. Ids travel with messages copied into other logs (detach, a fork), so one legacy id
 * must never name a message of another conversation.
 */
export function legacyMessageId(conversationId: string, ordinal: number): string {
  const salt = createHash("sha1")
    .update(conversationId)
    .digest("hex")
    .slice(0, LEGACY_ID_SALT_CHARS);
  return `v3-${salt}-${String(ordinal)}`;
}

export function buildConversationTree(
  events: readonly TreeEvent[],
  conversationId: string,
): ConversationTree {
  const nodes = new Map<string, ConversationTreeNode>();
  let leafId: string | null = null;
  // What a message without an id follows: the message before it in the file, or nothing
  // right after a `rewrite`.
  let previousInFile: string | null = null;
  let messageOrdinal = 0;

  for (const event of events) {
    switch (event.type) {
      case "message": {
        const ordinal = messageOrdinal;
        messageOrdinal += 1;
        if (event.id === undefined) {
          const id = legacyMessageId(conversationId, ordinal);
          nodes.set(id, {
            kind: "message",
            id,
            parentId: previousInFile,
            message: event.message,
            at: event.at,
          });
          previousInFile = id;
          leafId = id;
          break;
        }
        nodes.set(event.id, {
          kind: "message",
          id: event.id,
          parentId: event.parentId ?? null,
          message: event.message,
          at: event.at,
        });
        previousInFile = event.id;
        leafId = event.id;
        break;
      }
      case "context":
        nodes.set(event.id, {
          kind: "context",
          id: event.id,
          parentId: event.parentId,
          keep: event.keep,
        });
        leafId = event.id;
        break;
      case "leaf":
        if (event.id === null || nodes.has(event.id)) {
          leafId = event.id;
        }
        break;
      case "rewrite":
        previousInFile = null;
        break;
      case "other":
        break;
    }
  }
  return { nodes, leafId };
}

/** One message on the path the model sees, with its id in the log. */
export interface PathMessage {
  readonly id: string;
  readonly message: ChatMessage;
}

/**
 * The messages the model sees at the leaf, oldest first. Walks up from the leaf; a `context`
 * entry ends the walk and puts its kept runs in front of what follows it. A broken link (a
 * truncated file, a run naming an entry that is gone) ends the walk there rather than failing:
 * what can be read is still the conversation.
 */
export function contextPath(tree: ConversationTree): {
  readonly messages: readonly PathMessage[];
  /** Index in `messages` where entries after the nearest `context` entry begin; 0 without one. */
  readonly afterContext: number;
  readonly contextId: string | null;
} {
  const tail: PathMessage[] = [];
  let cursor = tree.leafId;
  let steps = 0;
  while (cursor !== null && steps <= tree.nodes.size) {
    steps += 1;
    const node = tree.nodes.get(cursor);
    if (node === undefined) {
      break;
    }
    if (node.kind === "context") {
      const kept = resolveKeep(tree, node.keep);
      tail.reverse();
      return { messages: [...kept, ...tail], afterContext: kept.length, contextId: node.id };
    }
    tail.push({ id: node.id, message: node.message });
    cursor = node.parentId;
  }
  tail.reverse();
  return { messages: tail, afterContext: 0, contextId: null };
}

function resolveKeep(tree: ConversationTree, keep: readonly KeepRun[]): PathMessage[] {
  const resolved: PathMessage[] = [];
  for (const run of keep) {
    const segment: PathMessage[] = [];
    let cursor: string | null = run.through;
    let steps = 0;
    while (cursor !== null && steps <= tree.nodes.size) {
      steps += 1;
      const node = tree.nodes.get(cursor);
      if (node?.kind !== "message") {
        break;
      }
      segment.push({ id: node.id, message: node.message });
      if (node.id === run.from) {
        break;
      }
      cursor = node.parentId;
    }
    segment.reverse();
    resolved.push(...segment);
  }
  return resolved;
}

/** What a save knows about the log it appends to. */
export interface TreeAppendState {
  readonly leafId: string | null;
  /** The model's path at the leaf: ids and fingerprints, oldest first. */
  readonly path: readonly { readonly id: string; readonly fingerprint: string }[];
  /** See {@link contextPath}. */
  readonly afterContext: number;
  readonly contextId: string | null;
  /** Every entry's parent, for telling which kept messages follow one another. */
  readonly parents: ReadonlyMap<string, string | null>;
}

export function treeAppendState(
  tree: ConversationTree,
  fingerprintOf: (message: ChatMessage) => string,
): TreeAppendState {
  const path = contextPath(tree);
  const parents = new Map<string, string | null>();
  for (const node of tree.nodes.values()) {
    parents.set(node.id, node.parentId);
  }
  return {
    leafId: tree.leafId,
    path: path.messages.map((entry) => ({
      id: entry.id,
      fingerprint: fingerprintOf(entry.message),
    })),
    afterContext: path.afterContext,
    contextId: path.contextId,
    parents,
  };
}

/** One entry a save appends. */
export type PlannedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly parentId: string | null;
      readonly message: ChatMessage;
    }
  | {
      readonly type: "context";
      readonly id: string;
      readonly parentId: string | null;
      readonly keep: readonly KeepRun[];
    }
  | { readonly type: "leaf"; readonly id: string | null };

export interface SavePlan {
  readonly entries: readonly PlannedEntry[];
  /** The id each saved message has in the log, in input order. */
  readonly ids: readonly string[];
  readonly state: TreeAppendState;
}

/** A fresh entry id: 8 hex characters, unique within the log. */
export function newEntryId(taken: ReadonlySet<string> | ReadonlyMap<string, unknown>): string {
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!taken.has(id)) {
      return id;
    }
  }
}

/**
 * What to append so the log's leaf holds `messages`, the transcript a writer has in hand.
 *
 * A message the log already holds is recognised by its `entryId`, or, when it carries none
 * the log knows (it was rebuilt, or came from another conversation), by its fingerprint at the
 * same place on the path. Then:
 *
 * - the transcript continues the path → its new messages are appended after the leaf;
 * - it keeps a prefix of the path and continues differently (`/retry`, an edit) → its new
 *   messages branch from the last message kept;
 * - anything else (compaction, the history cap) → its new messages are appended, and a
 *   `context` entry names the whole transcript as what the model sees now.
 */
export function planSave(
  state: TreeAppendState,
  messages: readonly ChatMessage[],
  fingerprintOf: (message: ChatMessage) => string,
): SavePlan {
  const parents = new Map(state.parents);
  const known = (message: ChatMessage): string | undefined =>
    message.entryId !== undefined && parents.has(message.entryId) ? message.entryId : undefined;

  const ids: string[] = [];
  let matched = 0;
  while (matched < messages.length && matched < state.path.length) {
    const message = messages[matched];
    const onPath = state.path[matched];
    if (message === undefined || onPath === undefined) {
      break;
    }
    const id = known(message);
    const same =
      id !== undefined ? id === onPath.id : fingerprintOf(message) === onPath.fingerprint;
    if (!same) {
      break;
    }
    ids.push(onPath.id);
    matched += 1;
  }

  const rest = messages.slice(matched);
  const restReusesEntries = rest.some((message) => known(message) !== undefined);
  const entries: PlannedEntry[] = [];

  // A message copied from another log (detach, a fork) keeps its id when this log has no entry
  // by that name, so the copy and the original agree on what each message is.
  const idFor = (message: ChatMessage): string =>
    message.entryId !== undefined && !parents.has(message.entryId)
      ? message.entryId
      : newEntryId(parents);

  const appendChain = (from: readonly ChatMessage[], parentId: string | null): string | null => {
    let parent = parentId;
    for (const message of from) {
      const id = idFor(message);
      parents.set(id, parent);
      entries.push({ type: "message", id, parentId: parent, message });
      ids.push(id);
      parent = id;
    }
    return parent;
  };

  const branchPoint = (): string | null | undefined => {
    if (matched === state.path.length) {
      return state.leafId;
    }
    if (state.contextId !== null && matched === state.afterContext) {
      return state.contextId;
    }
    if (matched > state.afterContext) {
      return state.path[matched - 1]?.id ?? null;
    }
    if (state.contextId === null && matched === 0) {
      return null;
    }
    // A branch inside the kept part of a context would walk up past the context entry and
    // read the history it left out; it needs a context of its own.
    return undefined;
  };

  const parent = restReusesEntries ? undefined : branchPoint();
  if (parent !== undefined) {
    let leafId = parent;
    if (rest.length > 0) {
      leafId = appendChain(rest, parent);
    } else if (parent !== state.leafId) {
      // Cut back with nothing new (a failed turn, `/retry` before it resends): the leaf moves
      // so that a reader of the file sees the same path as this writer.
      entries.push({ type: "leaf", id: parent });
    }
    // Every branch point accepted above lies on the walk through the current context entry
    // (or there is none), so what the context keeps is unchanged.
    return {
      entries,
      ids,
      state: {
        leafId,
        path: ids.map((id, index) => ({
          id,
          fingerprint:
            state.path[index]?.id === id
              ? (state.path[index]?.fingerprint ?? "")
              : fingerprintOf(messages[index] as ChatMessage),
        })),
        afterContext: state.afterContext,
        contextId: state.contextId,
        parents,
      },
    };
  }

  let previous: string | null = matched > 0 ? (ids[matched - 1] ?? null) : null;
  for (const message of rest) {
    const id = known(message);
    if (id !== undefined) {
      ids.push(id);
      previous = id;
      continue;
    }
    const created = idFor(message);
    parents.set(created, previous);
    entries.push({ type: "message", id: created, parentId: previous, message });
    ids.push(created);
    previous = created;
  }
  const contextId = newEntryId(parents);
  const keep = keepRuns(ids, parents);
  parents.set(contextId, state.leafId);
  entries.push({ type: "context", id: contextId, parentId: state.leafId, keep });
  return {
    entries,
    ids,
    state: {
      leafId: contextId,
      path: ids.map((id, index) => ({
        id,
        fingerprint: fingerprintOf(messages[index] as ChatMessage),
      })),
      afterContext: ids.length,
      contextId,
      parents,
    },
  };
}

/** `ids` as runs of entries that each follow the previous one, for a `context` entry's `keep`. */
export function keepRuns(
  ids: readonly string[],
  parents: ReadonlyMap<string, string | null>,
): KeepRun[] {
  const runs: KeepRun[] = [];
  let from: string | undefined;
  let through: string | undefined;
  for (const id of ids) {
    if (from !== undefined && through !== undefined && parents.get(id) === through) {
      through = id;
      continue;
    }
    if (from !== undefined && through !== undefined) {
      runs.push({ from, through });
    }
    from = id;
    through = id;
  }
  if (from !== undefined && through !== undefined) {
    runs.push({ from, through });
  }
  return runs;
}

/** Characters of a message shown to name a branch in a picker. */
const BRANCH_LABEL_CHARS = 72;

/** One place the conversation can continue from, for `/tree`. */
export interface ConversationBranch {
  /** The entry the conversation would continue after. */
  readonly tipId: string;
  /** The last thing said on the branch, one line. */
  readonly label: string;
  readonly messageCount: number;
  /** When its newest message was written. */
  readonly lastAt: string | null;
  readonly current: boolean;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > BRANCH_LABEL_CHARS
    ? `${line.slice(0, BRANCH_LABEL_CHARS - 1).trimEnd()}…`
    : line;
}

/**
 * Every place the conversation can continue from: each entry nothing follows, plus the current
 * leaf. Messages that only exist inside a `context` entry's view (a compaction summary) are not
 * branches of their own. Newest first, the current one marked.
 */
export function conversationBranches(tree: ConversationTree): ConversationBranch[] {
  const hasChildren = new Set<string>();
  const kept = new Set<string>();
  for (const node of tree.nodes.values()) {
    if (node.parentId !== null) {
      hasChildren.add(node.parentId);
    }
    if (node.kind === "context") {
      for (const entry of resolveKeep(tree, node.keep)) {
        kept.add(entry.id);
      }
    }
  }
  const tips = [...tree.nodes.values()]
    .filter((node) => !hasChildren.has(node.id) && !(node.kind === "message" && kept.has(node.id)))
    .map((node) => node.id);
  if (tree.leafId !== null && !tips.includes(tree.leafId)) {
    tips.push(tree.leafId);
  }
  const branches = tips.map((tipId): ConversationBranch => {
    const path = contextPath({ nodes: tree.nodes, leafId: tipId }).messages;
    const last = path.at(-1)?.message;
    let lastAt: string | null = null;
    for (const entry of path) {
      const node = tree.nodes.get(entry.id);
      if (node?.kind === "message" && (lastAt === null || node.at > lastAt)) {
        lastAt = node.at;
      }
    }
    return {
      tipId,
      label: oneLine(last?.content ?? ""),
      messageCount: path.length,
      lastAt,
      current: tipId === tree.leafId,
    };
  });
  return branches.sort((left, right) =>
    left.current !== right.current
      ? left.current
        ? -1
        : 1
      : (right.lastAt ?? "").localeCompare(left.lastAt ?? ""),
  );
}

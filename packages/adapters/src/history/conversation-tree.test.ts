import type { ChatMessage } from "@jazz/core/types/message";
import { describe, expect, test } from "bun:test";
import {
  buildConversationTree,
  contextPath,
  keepRuns,
  legacyMessageId,
  planSave,
  treeAppendState,
  type PlannedEntry,
  type TreeAppendState,
  type TreeEvent,
} from "./conversation-tree";

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

const fingerprintOf = (message: ChatMessage) => `${message.role}:${message.content}`;

const EMPTY: TreeAppendState = {
  leafId: null,
  path: [],
  afterContext: 0,
  contextId: null,
  parents: new Map(),
};

/** A log as events: what has been saved so far, replayed the way a reader sees it. */
class Log {
  readonly events: TreeEvent[] = [];
  state: TreeAppendState = EMPTY;

  save(messages: readonly ChatMessage[]): readonly PlannedEntry[] {
    const plan = planSave(this.state, messages, fingerprintOf);
    for (const entry of plan.entries) {
      if (entry.type === "message") {
        this.events.push({
          type: "message",
          at: "t",
          id: entry.id,
          parentId: entry.parentId,
          message: entry.message,
        });
      } else if (entry.type === "context") {
        this.events.push({
          type: "context",
          id: entry.id,
          parentId: entry.parentId,
          keep: entry.keep,
        });
      } else {
        this.events.push({ type: "leaf", id: entry.id });
      }
    }
    plan.ids.forEach((id, index) => {
      const message = messages[index];
      if (message) message.entryId = id;
    });
    this.state = plan.state;
    return plan.entries;
  }

  /** What a fresh reader of the file sees, and what it would plan the next save from. */
  read(): readonly string[] {
    const tree = buildConversationTree(this.events, "conv-1");
    expect(treeAppendState(tree, fingerprintOf).path).toEqual(this.state.path);
    return contextPath(tree).messages.map((entry) => entry.message.content);
  }

  /** Every message ever written, in file order. */
  record(): readonly string[] {
    return this.events.flatMap((event) =>
      event.type === "message" ? [event.message.content] : [],
    );
  }
}

describe("planSave", () => {
  test("a transcript that continues the path appends only its new messages", () => {
    const log = new Log();
    const history = [user("plan the trip"), assistant("where to?")];
    log.save(history);
    const added = log.save([...history, user("Basel"), assistant("booked")]);

    expect(added.map((entry) => entry.type)).toEqual(["message", "message"]);
    expect(log.read()).toEqual(["plan the trip", "where to?", "Basel", "booked"]);
  });

  test("a transcript rebuilt without ids is recognised by fingerprint, not appended again", () => {
    const log = new Log();
    log.save([user("plan the trip"), assistant("where to?")]);
    const added = log.save([user("plan the trip"), assistant("where to?"), user("Basel")]);
    expect(added).toHaveLength(1);
    expect(log.record()).toEqual(["plan the trip", "where to?", "Basel"]);
  });

  /** `/retry`: the old answer stays in the file, on a branch the conversation left. */
  test("dropping the last answer and continuing branches; the old answer is kept", () => {
    const log = new Log();
    const question = user("summarize the PR");
    const bad = assistant("It adds X");
    log.save([question, bad]);
    const added = log.save([question, assistant("It fixes Y")]);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ type: "message", parentId: question.entryId });
    expect(log.read()).toEqual(["summarize the PR", "It fixes Y"]);
    expect(log.record()).toEqual(["summarize the PR", "It adds X", "It fixes Y"]);
  });

  test("cutting back with nothing new moves the leaf, so a reader agrees", () => {
    const log = new Log();
    const question = user("summarize the PR");
    log.save([question, assistant("It adds X")]);
    const added = log.save([question]);

    expect(added).toEqual([{ type: "leaf", id: question.entryId ?? null }]);
    expect(log.read()).toEqual(["summarize the PR"]);
  });

  /** Compaction keeps a pinned task from the start, then the summary, then the recent tail. */
  test("compaction appends a context entry; every original stays in the file", () => {
    const log = new Log();
    const task = user("task: keep the budget under 500");
    const history = [
      task,
      assistant("ok"),
      user("flights?"),
      assistant("three options"),
      user("pick one"),
    ];
    log.save(history);

    const summary = assistant("summary: budget 500, three flight options");
    const recent = history.slice(3);
    const added = log.save([task, summary, ...recent]);

    expect(added.map((entry) => entry.type)).toEqual(["message", "context"]);
    expect(log.read()).toEqual([
      "task: keep the budget under 500",
      "summary: budget 500, three flight options",
      "three options",
      "pick one",
    ]);
    expect(log.record()).toEqual([...history.map((message) => message.content), summary.content]);

    log.save([task, summary, ...recent, assistant("booked the 9:00")]);
    expect(log.read().at(-1)).toBe("booked the 9:00");
  });

  test("retrying after compaction branches after the context entry", () => {
    const log = new Log();
    const history = [user("a"), assistant("b"), user("c"), assistant("d")];
    log.save(history);
    const summary = assistant("summary of a-b");
    log.save([summary, ...history.slice(2)]);

    log.save([summary, history[2] as ChatMessage, assistant("d, retried")]);
    expect(log.read()).toEqual(["summary of a-b", "c", "d, retried"]);
  });

  /** Branching inside what a context keeps would walk past it into the history it left out. */
  test("cutting into the kept part of a context writes a new context", () => {
    const log = new Log();
    const history = [user("a"), assistant("b"), user("c"), assistant("d")];
    log.save(history);
    const summary = assistant("summary of a-b");
    log.save([summary, ...history.slice(2)]);

    const added = log.save([summary, user("c, edited")]);
    expect(added.map((entry) => entry.type)).toEqual(["message", "context"]);
    expect(log.read()).toEqual(["summary of a-b", "c, edited"]);
  });

  test("the history cap keeps the newest messages without trimming the file", () => {
    const log = new Log();
    const history = Array.from({ length: 10 }, (_, index) => user(`m${String(index)}`));
    log.save(history);
    log.save(history.slice(4));

    expect(log.read()).toEqual(history.slice(4).map((message) => message.content));
    expect(log.record()).toHaveLength(10);
  });

  test("a fresh transcript under an existing log starts a new root instead of hiding the old one", () => {
    const log = new Log();
    log.save([user("old")]);
    log.save([user("new")]);
    expect(log.read()).toEqual(["new"]);
    expect(log.record()).toEqual(["old", "new"]);
  });
});

describe("buildConversationTree", () => {
  test("reads a log from before ids as chains that a rewrite restarts", () => {
    const tree = buildConversationTree(
      [
        { type: "message", at: "t", message: user("a") },
        { type: "message", at: "t", message: assistant("b") },
        { type: "rewrite" },
        { type: "message", at: "t", message: assistant("summary") },
        { type: "message", at: "t", message: user("c") },
      ],
      "conv-1",
    );
    const path = contextPath(tree).messages;
    expect(path.map((entry) => entry.message.content)).toEqual(["summary", "c"]);
    expect(path.map((entry) => entry.id)).toEqual([
      legacyMessageId("conv-1", 2),
      legacyMessageId("conv-1", 3),
    ]);
    expect(legacyMessageId("conv-2", 2)).not.toBe(legacyMessageId("conv-1", 2));
  });

  test("a message without an id follows the message before it, whatever its id", () => {
    const tree = buildConversationTree(
      [
        { type: "message", at: "t", id: "aaaa0001", parentId: null, message: user("a") },
        { type: "message", at: "t", message: assistant("b") },
      ],
      "conv-1",
    );
    expect(contextPath(tree).messages.map((entry) => entry.message.content)).toEqual(["a", "b"]);
  });

  test("a leaf event moves where the conversation continues", () => {
    const tree = buildConversationTree(
      [
        { type: "message", at: "t", id: "q", parentId: null, message: user("q") },
        { type: "message", at: "t", id: "a1", parentId: "q", message: assistant("a1") },
        { type: "message", at: "t", id: "a2", parentId: "q", message: assistant("a2") },
        { type: "leaf", id: "a1" },
      ],
      "conv-1",
    );
    expect(contextPath(tree).messages.map((entry) => entry.message.content)).toEqual(["q", "a1"]);
  });

  test("a link to an entry that is gone ends the path there instead of failing", () => {
    const tree = buildConversationTree(
      [{ type: "message", at: "t", id: "b", parentId: "missing", message: user("b") }],
      "conv-1",
    );
    expect(contextPath(tree).messages.map((entry) => entry.message.content)).toEqual(["b"]);
  });
});

describe("keepRuns", () => {
  test("names consecutive entries as one run", () => {
    const parents = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
      ["s", "a"],
      ["d", "c"],
    ]);
    expect(keepRuns(["a", "s", "c", "d"], parents)).toEqual([
      { from: "a", through: "s" },
      { from: "c", through: "d" },
    ]);
  });
});

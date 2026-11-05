import { beforeEach, describe, expect, test } from "bun:test";
import {
  addToCacheTally,
  cacheHitRate,
  cacheTallyHitRate,
  cacheTallyIsPartial,
  canonicalJson,
  classifyCacheChange,
  EMPTY_CACHE_TALLY,
  fingerprintRequest,
  formatCacheSummary,
  lastCacheObservation,
  normalizeCacheUsage,
  observeRequest,
  recordCacheUsage,
  resetCacheLedger,
  type CacheMissReason,
  type FingerprintInput,
} from "./prompt-cache";

const baseTools = [
  {
    name: "read_file",
    description: "Read a file.",
    schema: { type: "object", required: ["path"] },
  },
  { name: "ls", description: "List a directory.", schema: { type: "object" } },
];

function request(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    provider: "anthropic",
    model: "model-a",
    tools: baseTools,
    messages: [
      { role: "system", content: "persona" } as never,
      { role: "user", content: "hello" } as never,
    ],
    ...overrides,
  };
}

describe("fingerprintRequest", () => {
  test("is stable for identical input", () => {
    expect(fingerprintRequest(request())).toEqual(fingerprintRequest(request()));
  });

  test("tool key order does not change the tools hash", () => {
    const reordered = [
      {
        schema: { required: ["path"], type: "object" },
        description: "Read a file.",
        name: "read_file",
      },
      baseTools[1]!,
    ];
    expect(fingerprintRequest(request({ tools: reordered })).toolsHash).toBe(
      fingerprintRequest(request()).toolsHash,
    );
  });

  test("tool order is part of the hash", () => {
    const swapped = [baseTools[1]!, baseTools[0]!];
    expect(fingerprintRequest(request({ tools: swapped })).toolsHash).not.toBe(
      fingerprintRequest(request()).toolsHash,
    );
  });

  test("a changed tool description changes only the tools hash", () => {
    const edited = [{ ...baseTools[0]!, description: "Read a file from disk." }, baseTools[1]!];
    const before = fingerprintRequest(request());
    const after = fingerprintRequest(request({ tools: edited }));
    expect(after.toolsHash).not.toBe(before.toolsHash);
    expect(after.systemHash).toBe(before.systemHash);
    expect(after.messageHashes).toEqual(before.messageHashes);
  });

  test("appending a message keeps every earlier message hash", () => {
    const before = fingerprintRequest(request());
    const after = fingerprintRequest(
      request({
        messages: [
          ...request().messages,
          { role: "assistant", content: "hi" } as never,
          { role: "user", content: "more" } as never,
        ],
      }),
    );
    expect(after.messageHashes.slice(0, before.messageHashes.length)).toEqual(before.messageHashes);
    expect(after.systemHash).toBe(before.systemHash);
    expect(after.historyHash).not.toBe(before.historyHash);
  });

  test("the ephemeral tail is outside the fingerprint", () => {
    const withTail = fingerprintRequest(
      request({
        messages: [
          ...request().messages,
          { role: "user", content: "step 3 of 10", kind: "ephemeral" } as never,
        ],
      }),
    );
    expect(withTail).toEqual(fingerprintRequest(request()));
  });

  test("a changed system message changes only the system hash", () => {
    const before = fingerprintRequest(request());
    const after = fingerprintRequest(
      request({
        messages: [{ role: "system", content: "persona v2" } as never, request().messages[1]!],
      }),
    );
    expect(after.systemHash).not.toBe(before.systemHash);
    expect(after.toolsHash).toBe(before.toolsHash);
    expect(after.messageHashes).toEqual(before.messageHashes);
  });

  test("canonicalJson sorts keys at every depth", () => {
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: [{ z: 1, y: 2 }] })).toBe(
      '{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}',
    );
  });
});

describe("classifyCacheChange", () => {
  const first = fingerprintRequest(request());
  const appended = fingerprintRequest(
    request({ messages: [...request().messages, { role: "assistant", content: "ok" } as never] }),
  );

  const cases: readonly {
    readonly name: string;
    readonly previous: typeof first | undefined;
    readonly current: typeof first;
    readonly reason: CacheMissReason;
  }[] = [
    { name: "no previous request", previous: undefined, current: first, reason: "first-request" },
    { name: "identical request", previous: first, current: first, reason: "none" },
    { name: "pure append", previous: first, current: appended, reason: "none" },
    {
      name: "tools changed",
      previous: first,
      current: fingerprintRequest(request({ tools: [baseTools[0]!] })),
      reason: "tools-changed",
    },
    {
      name: "system changed",
      previous: first,
      current: fingerprintRequest(
        request({
          messages: [{ role: "system", content: "other" } as never, request().messages[1]!],
        }),
      ),
      reason: "system-changed",
    },
    {
      name: "history rewritten by compaction",
      previous: appended,
      current: fingerprintRequest(
        request({
          messages: [request().messages[0]!, { role: "user", content: "summary" } as never],
        }),
      ),
      reason: "history-rewritten",
    },
    {
      name: "history truncated",
      previous: appended,
      current: first,
      reason: "history-rewritten",
    },
    {
      name: "model changed",
      previous: first,
      current: fingerprintRequest(request({ model: "model-b" })),
      reason: "model-changed",
    },
    {
      name: "provider changed",
      previous: first,
      current: fingerprintRequest(request({ provider: "openai" })),
      reason: "provider-changed",
    },
  ];

  for (const { name, previous, current, reason } of cases) {
    test(name, () => {
      expect(classifyCacheChange(previous, current).reason).toBe(reason);
    });
  }

  test("tools win over system when both changed, and both are listed", () => {
    const current = fingerprintRequest(
      request({
        tools: [baseTools[0]!],
        messages: [{ role: "system", content: "other" } as never, request().messages[1]!],
      }),
    );
    const change = classifyCacheChange(first, current);
    expect(change.reason).toBe("tools-changed");
    expect(change.changed).toEqual(["tools", "system"]);
  });
});

describe("cache usage arithmetic", () => {
  test("subset convention: reads and writes are parts of promptTokens", () => {
    expect(
      normalizeCacheUsage(
        { promptTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 100 },
        "subset",
      ),
    ).toEqual({
      uncachedInputTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      totalInputTokens: 1000,
    });
    expect(cacheHitRate({ promptTokens: 1000, cacheReadTokens: 800 }, "subset")).toBeCloseTo(0.8);
  });

  test("disjoint convention: promptTokens is only the uncached share", () => {
    expect(
      normalizeCacheUsage(
        { promptTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 },
        "disjoint",
      ),
    ).toEqual({
      uncachedInputTokens: 100,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      totalInputTokens: 1000,
    });
    expect(
      cacheHitRate({ promptTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }, "disjoint"),
    ).toBeCloseTo(0.8);
  });

  test("Jazz's own convention is subset", () => {
    expect(cacheHitRate({ promptTokens: 1000, cacheReadTokens: 500 })).toBeCloseTo(0.5);
  });

  test("a reported zero is a 0% hit rate", () => {
    expect(cacheHitRate({ promptTokens: 1000, cacheReadTokens: 0 })).toBe(0);
  });

  test("no cache fields is unknown, never 0%", () => {
    expect(normalizeCacheUsage({ promptTokens: 1000 })).toBeUndefined();
    expect(cacheHitRate({ promptTokens: 1000 })).toBeUndefined();
  });

  test("a request with no input has no rate", () => {
    expect(cacheHitRate({ promptTokens: 0, cacheReadTokens: 0 })).toBeUndefined();
  });

  test("subset reads cannot exceed the prompt", () => {
    expect(cacheHitRate({ promptTokens: 100, cacheReadTokens: 500 })).toBe(1);
  });

  test("a tally weights requests by input and skips unreported ones", () => {
    let tally = EMPTY_CACHE_TALLY;
    tally = addToCacheTally(tally, { promptTokens: 1000, cacheReadTokens: 0 });
    tally = addToCacheTally(tally, { promptTokens: 3000, cacheReadTokens: 3000 });
    tally = addToCacheTally(tally, { promptTokens: 9999 });
    expect(cacheTallyHitRate(tally)).toBeCloseTo(0.75);
    expect(cacheTallyHitRate(EMPTY_CACHE_TALLY)).toBeUndefined();
  });
});

describe("formatCacheSummary", () => {
  test("unknown is spelled out", () => {
    expect(formatCacheSummary(undefined, "none")).toBe("cache unknown");
  });

  test("a healthy rate carries no reason", () => {
    expect(formatCacheSummary(0.82, "none")).toBe("cache 82%");
  });

  test("a low rate names the change", () => {
    expect(formatCacheSummary(0.1, "system-changed")).toBe("cache 10% (system prompt changed)");
  });
});

describe("ledger", () => {
  beforeEach(() => {
    resetCacheLedger();
  });

  test("classifies against the conversation's previous request and records usage", () => {
    const first = fingerprintRequest(request());
    const appended = fingerprintRequest(
      request({ messages: [...request().messages, { role: "user", content: "again" } as never] }),
    );
    expect(observeRequest("agent:conversation", first).reason).toBe("first-request");
    recordCacheUsage("agent:conversation", { promptTokens: 100, cacheReadTokens: 0 });
    expect(observeRequest("agent:conversation", appended).reason).toBe("none");
    recordCacheUsage("agent:conversation", { promptTokens: 200, cacheReadTokens: 100 });
    expect(lastCacheObservation("agent:conversation")?.hitRate).toBeCloseTo(0.5);
  });

  test("conversations do not share history", () => {
    const fingerprint = fingerprintRequest(request());
    observeRequest("one", fingerprint);
    expect(observeRequest("two", fingerprint).reason).toBe("first-request");
  });
});

describe("partial tallies", () => {
  test("a request with input and no cache fields marks the rate partial", () => {
    let tally = addToCacheTally(EMPTY_CACHE_TALLY, { promptTokens: 1000, cacheReadTokens: 900 });
    expect(cacheTallyIsPartial(tally)).toBe(false);
    tally = addToCacheTally(tally, { promptTokens: 1000 });
    expect(cacheTallyIsPartial(tally)).toBe(true);
    expect(cacheTallyHitRate(tally)).toBeCloseTo(0.9);
  });

  test("nothing reported is unknown, not partial", () => {
    const tally = addToCacheTally(EMPTY_CACHE_TALLY, { promptTokens: 1000 });
    expect(cacheTallyIsPartial(tally)).toBe(false);
    expect(cacheTallyHitRate(tally)).toBeUndefined();
  });

  test("the summary says partial", () => {
    expect(formatCacheSummary(0.9, "none", true)).toBe("cache 90% (partial)");
    expect(formatCacheSummary(0.1, "tools-changed", true)).toBe(
      "cache 10% (partial, tools changed)",
    );
  });
});

describe("fingerprint reuse", () => {
  test("an unchanged prefix is not hashed again and classification is unchanged", () => {
    let calls = 0;
    const hash = (text: string): string => {
      calls += 1;
      return `h${String(text.length)}:${text.slice(0, 40)}`;
    };
    const cache = new WeakMap();
    const history = [
      { role: "system", content: "persona" },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ];
    const first = fingerprintRequest({ ...request(), messages: history }, hash, cache);
    const callsAfterFirst = calls;
    const grown = [...history, { role: "user", content: "three" }];
    const second = fingerprintRequest({ ...request(), messages: grown }, hash, cache);
    const newHashes = calls - callsAfterFirst;
    expect(newHashes).toBe(1 + 3);
    expect(classifyCacheChange(first, second).reason).toBe("none");
    const uncached = fingerprintRequest({ ...request(), messages: grown }, hash, new WeakMap());
    expect(second).toEqual(uncached);
  });

  test("a message replaced with new content is hashed afresh", () => {
    const cache = new WeakMap();
    const message = { role: "user", content: "old" };
    const before = fingerprintRequest({ ...request(), messages: [message] }, undefined, cache);
    const after = fingerprintRequest(
      { ...request(), messages: [{ role: "user", content: "new" }] },
      undefined,
      cache,
    );
    expect(classifyCacheChange(before, after).reason).toBe("history-rewritten");
  });
});

/** Verifies catalog metadata and cache isolation across source URLs, disk snapshots, and offline runs. */
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  clearModelsDevCache,
  getMetadataFromMap,
  getModelsDevMap,
  getModelsDevMetadataSync,
  getModelsDevProviderModels,
  type ModelsDevMetadata,
} from "./models-dev";

const SAMPLE_API = {
  anthropic: {
    models: {
      "claude-test": {
        name: "Claude Test",
        limit: { context: 200000 },
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
};

const originalFetch = global.fetch;
const originalOffline = process.env["JAZZ_OFFLINE"];
const originalJazzHome = process.env["JAZZ_HOME"];
const originalMirror = process.env["JAZZ_MODELS_DEV_URL"];

let jazzHome: string;

function diskCachePath(): string {
  return join(jazzHome, "cache", "models-dev.json");
}

/** Seven hours: older than the six-hour snapshot lifetime. */
const STALE_SNAPSHOT_AGE_MS = 7 * 60 * 60 * 1000;

async function writeSnapshot(ageMs = 0): Promise<void> {
  await mkdir(join(jazzHome, "cache"), { recursive: true });
  await writeFile(diskCachePath(), JSON.stringify(SAMPLE_API), "utf8");
  const writtenAt = new Date(Date.now() - ageMs);
  await utimes(diskCachePath(), writtenAt, writtenAt);
}

function mockFetchSuccess(): ReturnType<typeof mock> {
  const fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify(SAMPLE_API), { status: 200 })),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockFetchFailure(): ReturnType<typeof mock> {
  const fetchMock = mock(() => Promise.reject(new Error("network unreachable")));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(async () => {
  jazzHome = await mkdtemp(join(tmpdir(), "jazz-models-dev-test-"));
  process.env["JAZZ_HOME"] = jazzHome;
  delete process.env["JAZZ_OFFLINE"];
  delete process.env["JAZZ_MODELS_DEV_URL"];
  clearModelsDevCache();
});

afterEach(async () => {
  global.fetch = originalFetch;
  if (originalOffline === undefined) delete process.env["JAZZ_OFFLINE"];
  else process.env["JAZZ_OFFLINE"] = originalOffline;
  if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = originalJazzHome;
  if (originalMirror === undefined) delete process.env["JAZZ_MODELS_DEV_URL"];
  else process.env["JAZZ_MODELS_DEV_URL"] = originalMirror;
  clearModelsDevCache();
  await rm(jazzHome, { recursive: true, force: true });
});

describe("models-dev disk cache", () => {
  it("mirrors a successful fetch to disk", async () => {
    mockFetchSuccess();

    const models = await getModelsDevProviderModels("anthropic");
    expect(models.map((model) => model.id)).toEqual(["claude-test"]);

    const raw = await readFile(diskCachePath(), "utf8");
    expect(JSON.parse(raw)).toEqual(SAMPLE_API);
  });

  it("keeps only the fields Jazz reads in the snapshot", async () => {
    const withExtras = {
      anthropic: {
        id: "anthropic",
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-test": {
            ...SAMPLE_API.anthropic.models["claude-test"],
            knowledge: "2025-01",
            open_weights: false,
            limit: { context: 200000, output: 64000 },
          },
        },
      },
    };
    global.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(withExtras), { status: 200 })),
    ) as unknown as typeof fetch;

    await getModelsDevProviderModels("anthropic");

    expect(JSON.parse(await readFile(diskCachePath(), "utf8"))).toEqual(SAMPLE_API);
  });

  it("uses a snapshot younger than six hours without fetching", async () => {
    await writeSnapshot();
    const fetchMock = mockFetchSuccess();

    const models = await getModelsDevProviderModels("anthropic");
    expect(models.map((model) => model.id)).toEqual(["claude-test"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches again once the snapshot is older than six hours", async () => {
    await writeSnapshot(STALE_SNAPSHOT_AGE_MS);
    const fetchMock = mockFetchSuccess();

    await getModelsDevProviderModels("anthropic");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to a stale disk snapshot when the fetch fails", async () => {
    await writeSnapshot(STALE_SNAPSHOT_AGE_MS);
    mockFetchFailure();

    const models = await getModelsDevProviderModels("anthropic");
    expect(models.map((model) => model.id)).toEqual(["claude-test"]);
  });

  it("returns null from the lenient path when the fetch fails and no snapshot exists", async () => {
    mockFetchFailure();

    expect(await getModelsDevMap()).toBeNull();
  });

  it("dedupes concurrent loads into a single fetch", async () => {
    const fetchMock = mockFetchSuccess();

    const [first, second, third] = await Promise.all([
      getModelsDevProviderModels("anthropic"),
      getModelsDevProviderModels("anthropic"),
      getModelsDevMap(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.map((model) => model.id)).toEqual(["claude-test"]);
    expect(second.map((model) => model.id)).toEqual(["claude-test"]);
    expect(third?.size).toBeGreaterThan(0);
  });
});

describe("models-dev offline mode", () => {
  it("never fetches and serves the disk snapshot", async () => {
    process.env["JAZZ_OFFLINE"] = "1";
    await writeSnapshot(STALE_SNAPSHOT_AGE_MS);
    const fetchMock = mockFetchSuccess();

    const models = await getModelsDevProviderModels("anthropic");
    expect(models.map((model) => model.id)).toEqual(["claude-test"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is lenient without a snapshot and strict paths explain the offline state", async () => {
    process.env["JAZZ_OFFLINE"] = "1";
    const fetchMock = mockFetchSuccess();

    expect(await getModelsDevMap()).toBeNull();
    await expect(getModelsDevProviderModels("anthropic")).rejects.toThrow(/JAZZ_OFFLINE/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("models-dev mirror override", () => {
  it("does not reuse a fresh public snapshot for a configured mirror", async () => {
    await writeSnapshot();
    process.env["JAZZ_MODELS_DEV_URL"] = "https://mirror.internal/api.json";
    const fetchMock = mockFetchSuccess();
    await getModelsDevMap();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://mirror.internal/api.json");
  });

  it("isolates memory, disk and offline fallback when the source URL changes", async () => {
    const catalog = (context: number) => ({
      anthropic: { models: { "claude-test": { limit: { context } } } },
    });
    const urlA = "https://mirror.internal/api.json?catalog=a";
    const urlB = "https://mirror.internal/api.json?catalog=b";
    const fetchMock = mock((url: string) =>
      Promise.resolve(Response.json(catalog(url === urlA ? 111 : 222))),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env["JAZZ_MODELS_DEV_URL"] = urlA;
    expect((await getModelsDevMap())?.get("claude-test")?.contextWindow).toBe(111);
    process.env["JAZZ_MODELS_DEV_URL"] = urlB;
    expect(getModelsDevMetadataSync("claude-test")).toBeUndefined();
    expect((await getModelsDevMap())?.get("claude-test")?.contextWindow).toBe(222);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clearModelsDevCache();
    process.env["JAZZ_MODELS_DEV_URL"] = urlA;
    expect((await getModelsDevMap())?.get("claude-test")?.contextWindow).toBe(111);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const cacheFiles = await readdir(join(jazzHome, "cache"));
    expect(cacheFiles).toHaveLength(2);
    const stale = new Date(Date.now() - STALE_SNAPSHOT_AGE_MS);
    for (const file of cacheFiles) {
      expect(file).toMatch(/^models-dev\.[a-f0-9]{64}\.json$/);
      await utimes(join(jazzHome, "cache", file), stale, stale);
    }
    clearModelsDevCache();
    process.env["JAZZ_OFFLINE"] = "1";
    process.env["JAZZ_MODELS_DEV_URL"] = urlA;
    expect((await getModelsDevMap())?.get("claude-test")?.contextWindow).toBe(111);
    process.env["JAZZ_MODELS_DEV_URL"] = urlB;
    expect((await getModelsDevMap())?.get("claude-test")?.contextWindow).toBe(222);
    process.env["JAZZ_MODELS_DEV_URL"] = "https://uncached.internal/api.json";
    expect(await getModelsDevMap()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent source loads separate when the previous URL completes last", async () => {
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (response: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    global.fetch = mock((url: string) => {
      if (url.includes("slow")) {
        started();
        return slowResponse;
      }
      return Promise.resolve(
        Response.json({ anthropic: { models: { fast: { limit: { context: 222 } } } } }),
      );
    }) as unknown as typeof fetch;
    process.env["JAZZ_MODELS_DEV_URL"] = "https://slow.internal/api.json";
    const slow = getModelsDevMap();
    await firstStarted;
    process.env["JAZZ_MODELS_DEV_URL"] = "https://fast.internal/api.json";
    const fast = getModelsDevMap();
    expect((await fast)?.has("fast")).toBe(true);
    finish(Response.json(SAMPLE_API));
    expect((await slow)?.has("claude-test")).toBe(true);
    expect(getModelsDevMetadataSync("fast")?.contextWindow).toBe(222);
  });

  it("fetches from JAZZ_MODELS_DEV_URL when set", async () => {
    const originalMirror = process.env["JAZZ_MODELS_DEV_URL"];
    process.env["JAZZ_MODELS_DEV_URL"] = "http://mirror.internal/api.json";
    const fetchMock = mockFetchSuccess();

    try {
      await getModelsDevProviderModels("anthropic");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://mirror.internal/api.json");
    } finally {
      if (originalMirror === undefined) delete process.env["JAZZ_MODELS_DEV_URL"];
      else process.env["JAZZ_MODELS_DEV_URL"] = originalMirror;
    }
  });
});

describe("getMetadataFromMap", () => {
  const metadata = (contextWindow: number) => ({ contextWindow }) as ModelsDevMetadata;
  const map = new Map<string, ModelsDevMetadata>([
    ["shared-model", metadata(1)],
    ["host-a:shared-model", metadata(2)],
  ]);

  it("prefers the provider's own entry, then any provider's", () => {
    expect(getMetadataFromMap(map, "shared-model", "host-a")?.contextWindow).toBe(2);
    expect(getMetadataFromMap(map, "shared-model", "host-b")?.contextWindow).toBe(1);
  });

  it("returns only the provider's own entry when anyProvider is false", () => {
    expect(
      getMetadataFromMap(map, "shared-model", "host-a", { anyProvider: false })?.contextWindow,
    ).toBe(2);
    expect(
      getMetadataFromMap(map, "shared-model", "host-b", { anyProvider: false }),
    ).toBeUndefined();
  });
});

describe("a model served on this machine", () => {
  const hosted = {
    contextWindow: 128_000,
    inputPricePerMillion: 0.35,
    outputPricePerMillion: 0.7,
  } as ModelsDevMetadata;
  const map = new Map<string, ModelsDevMetadata>([["gemma4", hosted]]);

  /**
   * The regression: a local `gemma4:12b` matched a cloud host's `gemma4` listing, so a run on
   * Ollama was billed at that host's rate and counted against dollar caps.
   */
  it("keeps a hosted listing's context window but costs nothing", () => {
    const local = getMetadataFromMap(map, "gemma4:12b", "ollama");
    expect(local?.contextWindow).toBe(128_000);
    expect(local?.inputPricePerMillion).toBe(0);
    expect(local?.outputPricePerMillion).toBe(0);
    expect(local?.cacheReadPricePerMillion).toBe(0);
  });

  it("keeps the price of an Ollama cloud model, which bills remotely, and of a hosted provider", () => {
    const cloudMap = new Map<string, ModelsDevMetadata>([["gemma4:31b-cloud", hosted]]);
    expect(getMetadataFromMap(cloudMap, "gemma4:31b-cloud", "ollama")?.inputPricePerMillion).toBe(
      0.35,
    );
    expect(getMetadataFromMap(map, "gemma4", "openrouter")?.inputPricePerMillion).toBe(0.35);
  });
});

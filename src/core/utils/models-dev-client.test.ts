import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  clearModelsDevCache,
  getModelsDevMap,
  getModelsDevProviderModels,
} from "./models-dev-client";

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

let jazzHome: string;

function diskCachePath(): string {
  return join(jazzHome, "cache", "models-dev.json");
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
  clearModelsDevCache();
});

afterEach(async () => {
  global.fetch = originalFetch;
  if (originalOffline === undefined) delete process.env["JAZZ_OFFLINE"];
  else process.env["JAZZ_OFFLINE"] = originalOffline;
  if (originalJazzHome === undefined) delete process.env["JAZZ_HOME"];
  else process.env["JAZZ_HOME"] = originalJazzHome;
  clearModelsDevCache();
  await rm(jazzHome, { recursive: true, force: true });
});

describe("models-dev-client disk cache", () => {
  it("mirrors a successful fetch to disk", async () => {
    mockFetchSuccess();

    const models = await getModelsDevProviderModels("anthropic");
    expect(models.map((model) => model.id)).toEqual(["claude-test"]);

    const raw = await readFile(diskCachePath(), "utf8");
    expect(JSON.parse(raw)).toEqual(SAMPLE_API);
  });

  it("falls back to the disk snapshot when the fetch fails", async () => {
    await mkdir(join(jazzHome, "cache"), { recursive: true });
    await writeFile(diskCachePath(), JSON.stringify(SAMPLE_API), "utf8");
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

describe("models-dev-client offline mode", () => {
  it("never fetches and serves the disk snapshot", async () => {
    process.env["JAZZ_OFFLINE"] = "1";
    await mkdir(join(jazzHome, "cache"), { recursive: true });
    await writeFile(diskCachePath(), JSON.stringify(SAMPLE_API), "utf8");
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

describe("models-dev-client mirror override", () => {
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

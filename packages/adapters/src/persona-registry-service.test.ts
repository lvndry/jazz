import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { PersonaRegistryServiceImpl } from "./persona-registry-service";

const BASE_URL = "https://registry.test/marketplace";

const INDEX = {
  version: 1,
  personas: [
    {
      name: "zebra",
      description: "Last alphabetically",
      url: "/marketplace/personas/zebra.md",
    },
    {
      name: "rubber-duck",
      description: "A debugging partner",
      tone: "calm",
      style: "methodical",
      author: "jazz",
      tags: ["debugging"],
      url: "/marketplace/personas/rubber-duck.md",
    },
    { name: "no-url", description: "Missing its url" },
    { name: "bad name", description: "Invalid slug", url: "/marketplace/personas/bad.md" },
  ],
};

const PERSONA_MD = `---
name: rubber-duck
description: A debugging partner
tone: calm
style: methodical
---

You are {agentName}, a debugging partner.
`;

const originalFetch = global.fetch;
const originalOffline = process.env["JAZZ_OFFLINE"];

let cacheDir: string;

function service(): PersonaRegistryServiceImpl {
  return new PersonaRegistryServiceImpl({ baseUrl: BASE_URL, cacheDir });
}

/** Serve the index and each persona markdown from an in-memory routing table. */
function mockFetch(routes: Record<string, string>): ReturnType<typeof mock> {
  const fetchMock = mock((input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = routes[url];
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(new Response(body, { status: 200 }));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function defaultRoutes(): Record<string, string> {
  return {
    [`${BASE_URL}/personas.json`]: JSON.stringify(INDEX),
    [`${BASE_URL}/personas/rubber-duck.md`]: PERSONA_MD,
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

/** Run an effect and return the error it failed with, or null if it succeeded. */
async function runFailure<A, E>(effect: Effect.Effect<A, E>): Promise<E | null> {
  const exit = await Effect.runPromise(Effect.exit(effect));
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.failureOption(exit.cause));
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "jazz-persona-registry-test-"));
  delete process.env["JAZZ_OFFLINE"];
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalOffline === undefined) delete process.env["JAZZ_OFFLINE"];
  else process.env["JAZZ_OFFLINE"] = originalOffline;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("PersonaRegistryService", () => {
  describe("listEntries", () => {
    it("returns valid entries sorted by name and drops malformed ones", async () => {
      mockFetch(defaultRoutes());

      const entries = await run(service().listEntries());

      expect(entries.map((entry) => entry.name)).toEqual(["rubber-duck", "zebra"]);
      expect(entries[0]?.tags).toEqual(["debugging"]);
      expect(entries[0]?.author).toBe("jazz");
    });

    it("serves a second call from the disk snapshot without re-fetching", async () => {
      const fetchMock = mockFetch(defaultRoutes());

      await run(service().listEntries());
      await run(service().listEntries());

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("re-fetches when refresh is requested", async () => {
      const fetchMock = mockFetch(defaultRoutes());

      await run(service().listEntries());
      await run(service().listEntries({ refresh: true }));

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("falls back to the cached snapshot when the registry is unreachable", async () => {
      mockFetch(defaultRoutes());
      await run(service().listEntries());

      global.fetch = mock(() =>
        Promise.reject(new Error("network down")),
      ) as unknown as typeof fetch;
      const entries = await run(service().listEntries({ refresh: true }));

      expect(entries.map((entry) => entry.name)).toEqual(["rubber-duck", "zebra"]);
    });

    it("uses the cached snapshot offline instead of hitting the network", async () => {
      mockFetch(defaultRoutes());
      await run(service().listEntries());

      process.env["JAZZ_OFFLINE"] = "1";
      const fetchMock = mockFetch(defaultRoutes());
      const entries = await run(service().listEntries({ refresh: true }));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(entries).toHaveLength(2);
    });

    it("fails with a NetworkError when offline with nothing cached", async () => {
      process.env["JAZZ_OFFLINE"] = "1";
      mockFetch(defaultRoutes());

      const error = await runFailure(service().listEntries());

      expect(error?._tag).toBe("NetworkError");
    });

    it("fails when the registry is unreachable and nothing is cached", async () => {
      global.fetch = mock(() =>
        Promise.reject(new Error("network down")),
      ) as unknown as typeof fetch;

      const error = await runFailure(service().listEntries());

      expect(error?._tag).toBe("NetworkError");
    });
  });

  describe("fetchPersona", () => {
    it("downloads the definition and splits frontmatter from the prompt", async () => {
      mockFetch(defaultRoutes());

      const download = await run(service().fetchPersona("rubber-duck"));

      expect(download.entry.name).toBe("rubber-duck");
      expect(download.sourceUrl).toBe(`${BASE_URL}/personas/rubber-duck.md`);
      expect(download.tone).toBe("calm");
      expect(download.style).toBe("methodical");
      expect(download.systemPrompt).toBe("You are {agentName}, a debugging partner.");
    });

    it("matches the catalog name case-insensitively", async () => {
      mockFetch(defaultRoutes());

      const download = await run(service().fetchPersona("RUBBER-DUCK"));

      expect(download.entry.name).toBe("rubber-duck");
    });

    it("fails when the persona is not in the catalog", async () => {
      mockFetch(defaultRoutes());

      const error = await runFailure(service().fetchPersona("missing"));

      expect(error?._tag).toBe("ValidationError");
    });

    it("refuses an entry whose url points off the registry origin", async () => {
      const hostileIndex = {
        version: 1,
        personas: [
          {
            name: "hostile",
            description: "Points elsewhere",
            url: "https://evil.example/prompt.md",
          },
        ],
      };
      mockFetch({
        [`${BASE_URL}/personas.json`]: JSON.stringify(hostileIndex),
        "https://evil.example/prompt.md": "---\nname: hostile\n---\nowned",
      });

      const error = await runFailure(service().fetchPersona("hostile"));

      expect(error?._tag).toBe("ValidationError");
      expect(String((error as { message?: string })?.message)).toContain("outside the registry");
    });

    it("refuses a definition with an empty prompt body", async () => {
      mockFetch({
        ...defaultRoutes(),
        [`${BASE_URL}/personas/rubber-duck.md`]: "---\nname: rubber-duck\n---\n\n",
      });

      const error = await runFailure(service().fetchPersona("rubber-duck"));

      expect(String((error as { message?: string })?.message)).toContain("empty system prompt");
    });

    it("refuses a prompt over the 10,000-character limit", async () => {
      mockFetch({
        ...defaultRoutes(),
        [`${BASE_URL}/personas/rubber-duck.md`]: `---\nname: rubber-duck\n---\n\n${"a".repeat(10_001)}`,
      });

      const error = await runFailure(service().fetchPersona("rubber-duck"));

      expect(String((error as { message?: string })?.message)).toContain("character prompt limit");
    });

    it("surfaces a NetworkError when the definition cannot be downloaded", async () => {
      mockFetch({ [`${BASE_URL}/personas.json`]: JSON.stringify(INDEX) });

      const error = await runFailure(service().fetchPersona("rubber-duck"));

      expect(error?._tag).toBe("NetworkError");
    });
  });
});

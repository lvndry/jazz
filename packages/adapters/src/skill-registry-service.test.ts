import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";
import { SkillRegistryServiceImpl, parseRegistrySkillMetadata } from "./skill-registry-service";

/** The skill adapter pins catalog caching, source fidelity, and the single-file boundary. */

const BASE_URL = "https://registry.test/library";
const SKILL_MD = `---
name: release-council
description: Run a multi-agent release review
author: Jazz
tags: [release, verification]
version: 1.2.0
---

# Release council

Review the release with independent agents.
`;
const INDEX = {
  version: 1,
  skills: [
    {
      name: "release-council",
      description: "Run a multi-agent release review",
      author: "Jazz",
      tags: ["release", "verification"],
      version: "1.2.0",
      url: "/library/skills/release-council/SKILL.md",
    },
    { name: "bad name", description: "Invalid", url: "/library/skills/bad/SKILL.md" },
    { name: "missing-url", description: "Invalid" },
  ],
};

const originalFetch = global.fetch;
const originalOffline = process.env["JAZZ_OFFLINE"];
let cacheDir: string;

function service(): SkillRegistryServiceImpl {
  return new SkillRegistryServiceImpl({ baseUrl: BASE_URL, cacheDir });
}

function mockFetch(routes: Record<string, string>): ReturnType<typeof mock> {
  const fetchMock = mock((input: string | URL) => {
    const body = routes[typeof input === "string" ? input : input.toString()];
    return Promise.resolve(
      body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 }),
    );
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function routes(skill = SKILL_MD): Record<string, string> {
  return {
    [`${BASE_URL}/skills.json`]: JSON.stringify(INDEX),
    [`${BASE_URL}/skills/release-council/SKILL.md`]: skill,
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

async function runFailure<A, E>(effect: Effect.Effect<A, E>): Promise<E | null> {
  const exit = await Effect.runPromise(Effect.exit(effect));
  if (Exit.isSuccess(exit)) return null;
  return Option.getOrNull(Cause.failureOption(exit.cause));
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "jazz-skill-registry-test-"));
  delete process.env["JAZZ_OFFLINE"];
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalOffline === undefined) delete process.env["JAZZ_OFFLINE"];
  else process.env["JAZZ_OFFLINE"] = originalOffline;
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("SkillRegistryService", () => {
  it("parses and sorts instruction-only catalog metadata", async () => {
    mockFetch(routes());

    const entries = await run(service().listEntries());

    expect(entries.map((entry) => entry.name)).toEqual(["release-council"]);
    expect(entries[0]?.version).toBe("1.2.0");
  });

  it("fetches the published SKILL.md byte-for-byte and parses its metadata", async () => {
    mockFetch(routes());

    const download = await run(service().fetchSkill("RELEASE-COUNCIL"));

    expect(download.markdown).toBe(SKILL_MD);
    expect(download.sourceUrl).toBe(`${BASE_URL}/skills/release-council/SKILL.md`);
    expect(download.metadata).toMatchObject({
      name: "release-council",
      description: "Run a multi-agent release review",
      version: "1.2.0",
    });
  });

  it("uses the cached index offline", async () => {
    mockFetch(routes());
    await run(service().listEntries());

    process.env["JAZZ_OFFLINE"] = "1";
    const fetchMock = mockFetch(routes());
    const entries = await run(service().listEntries({ refresh: true }));

    expect(entries).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a catalog source outside the registry origin", async () => {
    mockFetch({
      [`${BASE_URL}/skills.json`]: JSON.stringify({
        version: 1,
        skills: [
          {
            name: "hostile",
            description: "Points elsewhere",
            url: "https://evil.example/SKILL.md",
          },
        ],
      }),
    });

    const error = await runFailure(service().fetchSkill("hostile"));

    expect(error?._tag).toBe("ValidationError");
    expect(String((error as { message?: string })?.message)).toContain("outside the registry");
  });

  it("rejects bundles and executable frontmatter", async () => {
    mockFetch({
      [`${BASE_URL}/skills.json`]: JSON.stringify({
        version: 1,
        skills: [
          {
            name: "release-council",
            description: "Run a multi-agent release review",
            url: "/library/skills/release-council/archive.zip",
          },
        ],
      }),
      [`${BASE_URL}/skills/release-council/archive.zip`]: SKILL_MD,
    });
    const bundleError = await runFailure(service().fetchSkill("release-council"));
    expect(bundleError?._tag).toBe("ValidationError");

    expect(
      parseRegistrySkillMetadata(
        `${SKILL_MD.replace("version: 1.2.0", "scripts: [install.sh]")}`,
        "release-council",
      ),
    ).toBeNull();
  });

  it("accepts the website's flattened raw markdown route", async () => {
    const flattenedUrl = `${BASE_URL}/skills/release-council.md`;
    mockFetch({
      [`${BASE_URL}/skills.json`]: JSON.stringify({
        version: 1,
        skills: [
          {
            name: "release-council",
            description: "Run a multi-agent release review",
            url: "/library/skills/release-council.md",
          },
        ],
      }),
      [flattenedUrl]: SKILL_MD,
    });

    const download = await run(service().fetchSkill("release-council"));
    expect(download.sourceUrl).toBe(flattenedUrl);
  });

  it("rejects a SKILL.md whose frontmatter name does not match the catalog", async () => {
    mockFetch(routes(SKILL_MD.replace("name: release-council", "name: different-skill")));

    const error = await runFailure(service().fetchSkill("release-council"));

    expect(error?._tag).toBe("ValidationError");
    expect(String((error as { message?: string })?.message)).toContain("invalid SKILL.md");
  });
});

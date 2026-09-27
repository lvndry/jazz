/**
 * The read tools against Jazz's own secret files, in a throwaway JAZZ_HOME. Mirrors the
 * first half of the audit's exfiltration chain (`chain.ts`): `read_file` of
 * `$JAZZ_HOME/secrets.json` must return metadata without credential values.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createPdfPageCountTool } from "./pdf-page-count";
import { createReadFileTool } from "./read";
import { createReadPdfTool } from "./read-pdf";
import { runTool } from "./test-helpers";

let root: string;
let home: string;
let jazzHome: string;
let workspace: string;
let previousJazzHome: string | undefined;
let previousConfigPath: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-secret-tools-")));
  home = path.join(root, "home");
  jazzHome = path.join(home, "jazz-home");
  workspace = path.join(home, "project");
  fs.mkdirSync(path.join(jazzHome, ".secrets.lock"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(jazzHome, ".secrets.lock", "owner"), "needle lock");
  fs.writeFileSync(path.join(jazzHome, "secrets.json"), '{"token":"needle-secret"}');
  fs.writeFileSync(path.join(jazzHome, "config.json"), '{"daemon":{"token":"needle-daemon"}}');
  fs.writeFileSync(path.join(home, "notes.md"), "a needle in notes");
  fs.writeFileSync(path.join(workspace, "todo.md"), "project needle");

  previousJazzHome = process.env["JAZZ_HOME"];
  previousConfigPath = process.env["JAZZ_CONFIG_PATH"];
  process.env["JAZZ_HOME"] = jazzHome;
  delete process.env["JAZZ_CONFIG_PATH"];
});

afterEach(() => {
  if (previousConfigPath === undefined) {
    delete process.env["JAZZ_CONFIG_PATH"];
  } else {
    process.env["JAZZ_CONFIG_PATH"] = previousConfigPath;
  }
  if (previousJazzHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousJazzHome;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("returns protected metadata for $JAZZ_HOME/secrets.json", async () => {
    const result = await runTool(
      createReadFileTool(),
      { path: path.join(jazzHome, "secrets.json") },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ protected: true, contentOmitted: true });
    expect(JSON.stringify(result)).not.toContain("needle-secret");
  });

  it.each([".secrets.json-123-id.tmp", "config.json.corrupt-2026-09-27"])(
    "omits contents of the credential copy %s left by durable storage",
    async (filename) => {
      const secretCopy = path.join(jazzHome, filename);
      fs.writeFileSync(secretCopy, "needle-secret-copy");
      const result = await runTool(createReadFileTool(), { path: secretCopy }, workspace);
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ protected: true, contentOmitted: true });
      expect(JSON.stringify(result)).not.toContain("needle-secret-copy");
    },
  );

  it("protects a symlink that points at the config holding the daemon token", async () => {
    const link = path.join(workspace, "harmless.txt");
    fs.symlinkSync(path.join(jazzHome, "config.json"), link);
    const result = await runTool(createReadFileTool(), { path: link }, workspace);
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ protected: true, contentOmitted: true });
  });

  it("frames a file outside the working directory and leaves one inside unframed", async () => {
    const outside = await runTool(
      createReadFileTool(),
      { path: path.join(home, "notes.md") },
      workspace,
    );
    expect(outside.success).toBe(true);
    expect(outside.untrusted?.kind).toBe("local-file");

    const inside = await runTool(
      createReadFileTool(),
      { path: path.join(workspace, "todo.md") },
      workspace,
    );
    expect(inside.success).toBe(true);
    expect(inside.untrusted).toBeUndefined();
  });
});

describe("PDF metadata-only reads", () => {
  it("omits protected contents before extension checks or PDF parsing", async () => {
    for (const tool of [createReadPdfTool(), createPdfPageCountTool()]) {
      const result = await runTool(tool, { path: path.join(jazzHome, "secrets.json") }, workspace);
      expect(result.success).toBe(true);
      expect(result.result).toMatchObject({ protected: true, contentOmitted: true });
      expect(JSON.stringify(result)).not.toContain("needle-secret");
    }
  });
});

describe("grep", () => {
  it("drops matches inside secret files from a search that spans them", async () => {
    const result = await runTool(
      createGrepTool(),
      { pattern: "needle", path: home, outputMode: "files" },
      workspace,
    );
    expect(result.success).toBe(true);
    const files = (result.result as { files: string[] }).files;
    expect(files.some((file) => file.endsWith("notes.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("secrets.json"))).toBe(false);
    expect(files.some((file) => file.endsWith("config.json"))).toBe(false);
  });

  it("returns metadata for a secret lock directory", async () => {
    const result = await runTool(
      createGrepTool(),
      { pattern: "needle", path: path.join(jazzHome, ".secrets.lock") },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ protected: true, contentOmitted: true });
  });
});

describe("ls and find", () => {
  it("ls discovers protected paths without reading their contents", async () => {
    const refused = await runTool(
      createLsTool(),
      { path: path.join(jazzHome, ".secrets.lock") },
      workspace,
    );
    expect(refused.success).toBe(true);

    const listing = await runTool(
      createLsTool(),
      { path: home, showHidden: true, recursive: true },
      workspace,
    );
    expect(listing.success).toBe(true);
    const paths = (listing.result as { path: string }[]).map((entry) => entry.path);
    expect(paths.some((entry) => entry.endsWith("notes.md"))).toBe(true);
    expect(paths.some((entry) => entry.includes(".secrets.lock"))).toBe(true);
    expect(paths.some((entry) => entry.endsWith("secrets.json"))).toBe(true);
  });

  it("find lists protected paths from a secret lock directory", async () => {
    const result = await runTool(
      createFindTool(),
      { path: path.join(jazzHome, ".secrets.lock"), name: "*" },
      workspace,
    );
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      results: [expect.objectContaining({ protected: true })],
    });
  });
});

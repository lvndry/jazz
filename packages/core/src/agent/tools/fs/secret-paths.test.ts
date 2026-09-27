/**
 * The read tools against the secret-path list, in a throwaway HOME and JAZZ_HOME. Mirrors the
 * first half of the audit's exfiltration chain (`chain.ts`): `read_file` of
 * `$JAZZ_HOME/secrets.json` must come back refused.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadFileTool } from "./read";
import { runTool } from "./test-helpers";

let root: string;
let home: string;
let jazzHome: string;
let workspace: string;
let previousHome: string | undefined;
let previousJazzHome: string | undefined;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jazz-secret-tools-")));
  home = path.join(root, "home");
  jazzHome = path.join(home, "jazz-home");
  workspace = path.join(home, "project");
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.mkdirSync(jazzHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY needle");
  fs.writeFileSync(path.join(jazzHome, "secrets.json"), '{"token":"needle-secret"}');
  fs.writeFileSync(path.join(home, "notes.md"), "a needle in notes");
  fs.writeFileSync(path.join(workspace, "todo.md"), "project needle");

  previousHome = process.env["HOME"];
  previousJazzHome = process.env["JAZZ_HOME"];
  process.env["HOME"] = home;
  process.env["JAZZ_HOME"] = jazzHome;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = previousHome;
  }
  if (previousJazzHome === undefined) {
    delete process.env["JAZZ_HOME"];
  } else {
    process.env["JAZZ_HOME"] = previousJazzHome;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("refuses $JAZZ_HOME/secrets.json", async () => {
    const result = await runTool(
      createReadFileTool(),
      { path: path.join(jazzHome, "secrets.json") },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Refused to read");
    expect(JSON.stringify(result)).not.toContain("needle-secret");
  });

  it("refuses a symlink that points at an SSH key", async () => {
    const link = path.join(workspace, "harmless.txt");
    fs.symlinkSync(path.join(home, ".ssh", "id_ed25519"), link);
    const result = await runTool(createReadFileTool(), { path: link }, workspace);
    expect(result.success).toBe(false);
    expect(result.error).toContain("SSH keys");
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
    expect(files.some((file) => file.includes(".ssh"))).toBe(false);
  });

  it("refuses to start inside a secret directory", async () => {
    const result = await runTool(
      createGrepTool(),
      { pattern: "PRIVATE", path: path.join(home, ".ssh") },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Refused to read");
  });
});

describe("ls and find", () => {
  it("ls refuses a secret directory and hides one inside a listing", async () => {
    const refused = await runTool(createLsTool(), { path: path.join(home, ".ssh") }, workspace);
    expect(refused.success).toBe(false);

    const listing = await runTool(
      createLsTool(),
      { path: home, showHidden: true, recursive: true },
      workspace,
    );
    expect(listing.success).toBe(true);
    const paths = (listing.result as { path: string }[]).map((entry) => entry.path);
    expect(paths.some((entry) => entry.endsWith("notes.md"))).toBe(true);
    expect(paths.some((entry) => entry.includes(`${path.sep}.ssh`))).toBe(false);
    expect(paths.some((entry) => entry.endsWith("secrets.json"))).toBe(false);
  });

  it("find refuses a secret directory as its starting point", async () => {
    const result = await runTool(
      createFindTool(),
      { path: path.join(home, ".ssh"), name: "*" },
      workspace,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Refused to read");
  });
});

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createPdfTool } from "../create-pdf";
import { createCpTools } from "./cp";
import { createMkdirTools } from "./mkdir";
import { createMvTools } from "./mv";
import { createRmTools } from "./rm";
import { runTool } from "./test-helpers";

/**
 * Runs each in-process mutator through its real tool execution path under confinement.
 * `outside` sits under the cwd, beside no temp root the policy allows.
 */
let workspace: string;
let outside: string;

beforeAll(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "jazz-confined-mutators-")));
  outside = mkdtempSync(join(process.cwd(), ".confined-mutators-outside-"));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const confined = { shellConfinement: "on" as const };
const off = { shellConfinement: "off" as const };

describe("rm under write confinement", () => {
  const rm = createRmTools();

  it("refuses to delete outside the roots and leaves the file", async () => {
    const target = join(outside, "keep.txt");
    writeFileSync(target, "keep");
    const result = await runTool(rm.execute, { path: target }, workspace, confined);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Write confinement is on");
    expect(existsSync(target)).toBe(true);
  });

  it("removes a symlink inside the workspace without touching its outside target", async () => {
    const real = join(outside, "linked-target.txt");
    writeFileSync(real, "keep");
    const link = join(workspace, "link-to-outside");
    symlinkSync(real, link);
    const result = await runTool(rm.execute, { path: link }, workspace, confined);
    expect(result.success).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(existsSync(link)).toBe(false);
  });

  it("refuses a delete through a symlinked directory that leaves the workspace", async () => {
    const real = join(outside, "via-dir.txt");
    writeFileSync(real, "keep");
    symlinkSync(outside, join(workspace, "dir-link"));
    const result = await runTool(
      rm.execute,
      { path: join(workspace, "dir-link", "via-dir.txt") },
      workspace,
      confined,
    );
    expect(result.success).toBe(false);
    expect(existsSync(real)).toBe(true);
  });

  it("deletes inside the workspace, and anywhere with confinement off", async () => {
    const inside = join(workspace, "gone.txt");
    writeFileSync(inside, "x");
    expect((await runTool(rm.execute, { path: inside }, workspace, confined)).success).toBe(true);
    expect(existsSync(inside)).toBe(false);

    const free = join(outside, "free.txt");
    writeFileSync(free, "x");
    expect((await runTool(rm.execute, { path: free }, workspace, off)).success).toBe(true);
    expect(existsSync(free)).toBe(false);
  });
});

describe("mv under write confinement", () => {
  const mv = createMvTools();

  it("refuses a destination outside the roots", async () => {
    const source = join(workspace, "mv-source.txt");
    writeFileSync(source, "x");
    const destination = join(outside, "moved.txt");
    const result = await runTool(mv.execute, { source, destination }, workspace, confined);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Write confinement is on");
    expect(existsSync(source)).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses a source outside the roots, since moving removes it", async () => {
    const source = join(outside, "mv-outside.txt");
    writeFileSync(source, "x");
    const result = await runTool(
      mv.execute,
      { source, destination: join(workspace, "pulled.txt") },
      workspace,
      confined,
    );
    expect(result.success).toBe(false);
    expect(existsSync(source)).toBe(true);
  });

  it("moves inside the workspace", async () => {
    const source = join(workspace, "mv-a.txt");
    writeFileSync(source, "x");
    const destination = join(workspace, "mv-b.txt");
    const result = await runTool(mv.execute, { source, destination }, workspace, confined);
    expect(result.success).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("x");
  });
});

describe("cp under write confinement", () => {
  const cp = createCpTools();

  it("refuses a destination outside the roots and one reached through a symlink", async () => {
    const source = join(workspace, "cp-source.txt");
    writeFileSync(source, "x");
    const direct = await runTool(
      cp.execute,
      { source, destination: join(outside, "copy.txt") },
      workspace,
      confined,
    );
    expect(direct.success).toBe(false);
    expect(existsSync(join(outside, "copy.txt"))).toBe(false);

    symlinkSync(outside, join(workspace, "cp-link"));
    const viaLink = await runTool(
      cp.execute,
      { source, destination: join(workspace, "cp-link", "copy.txt") },
      workspace,
      confined,
    );
    expect(viaLink.success).toBe(false);
    expect(existsSync(join(outside, "copy.txt"))).toBe(false);
  });

  it("copies inside the workspace", async () => {
    const source = join(workspace, "cp-in.txt");
    writeFileSync(source, "x");
    const destination = join(workspace, "cp-out.txt");
    expect((await runTool(cp.execute, { source, destination }, workspace, confined)).success).toBe(
      true,
    );
    expect(readFileSync(destination, "utf8")).toBe("x");
  });
});

describe("mkdir under write confinement", () => {
  const mkdir = createMkdirTools();

  it("refuses a directory outside the roots, including through a symlink", async () => {
    const direct = await runTool(
      mkdir.execute,
      { path: join(outside, "new-dir") },
      workspace,
      confined,
    );
    expect(direct.success).toBe(false);
    expect(existsSync(join(outside, "new-dir"))).toBe(false);

    symlinkSync(outside, join(workspace, "mkdir-link"));
    const viaLink = await runTool(
      mkdir.execute,
      { path: join(workspace, "mkdir-link", "new-dir") },
      workspace,
      confined,
    );
    expect(viaLink.success).toBe(false);
    expect(existsSync(join(outside, "new-dir"))).toBe(false);
  });

  it("creates nested directories inside the workspace", async () => {
    const target = join(workspace, "a", "b");
    const result = await runTool(mkdir.execute, { path: target }, workspace, confined);
    expect(result.success).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});

describe("create_pdf under write confinement", () => {
  const pdf = createPdfTool(() => ({
    configuredExecutablePath: undefined,
    findSystemChrome: () => Promise.resolve(null),
  }));

  it("refuses an output path outside the roots before writing the source file", async () => {
    const output = join(outside, "report.pdf");
    const result = await runTool(
      pdf,
      { html: "<p>x</p>", title: "Report", path: output },
      workspace,
      confined,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Write confinement is on");
    expect(existsSync(`${output}.source.html`)).toBe(false);
  });

  it("does not interfere with an output path inside the workspace", async () => {
    const result = await runTool(
      pdf,
      { html: "<p>x</p>", title: "Report", path: join(workspace, "report.pdf") },
      workspace,
      confined,
    );
    expect(result.error ?? "").not.toContain("Write confinement is on");
  });
});

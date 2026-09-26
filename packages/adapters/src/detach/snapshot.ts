/**
 * Portable, verified conversation snapshot for a remote Jazz handoff.
 *
 * The caller chooses one workspace root and reviews the resulting manifest before
 * transfer. Files outside that root are never inferred from transcript text.
 * This deliberately rejects symlinks and oversized trees instead of following
 * an uncertain path into private files. Import verifies every byte before any
 * destination write and expects a dedicated remote Jazz home/workspace.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { NodeFileSystem } from "@effect/platform-node";
import type { ChatMessage } from "@jazz/core/types/message";
import { getJazzHomeDirectory } from "@jazz/core/utils/paths";
import { Effect } from "effect";
import {
  loadConversation,
  saveConversation,
  type Conversation,
} from "../history/conversation-history-service";
import { BUILTIN_PERSONA_NAMES } from "../persona-service";

const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 50_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const execFileAsync = promisify(execFile);

export interface DetachEntry {
  readonly kind:
    | "history"
    | "work"
    | "todos"
    | "artifact"
    | "workspace"
    | "config"
    | "git"
    | "skill"
    | "persona";
  /** Relative to the bundle root, and also to the destination category root. */
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface DetachManifest {
  readonly version: 1;
  readonly handoffId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly deletedPaths: readonly string[];
  readonly entries: readonly DetachEntry[];
}

export interface CreateDetachSnapshotInput {
  readonly agentId: string;
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly handoffId: string;
  readonly bundleDirectory: string;
  /** Exact latest terminal history, if the disk log has not yet caught up. */
  readonly history?: readonly ChatMessage[];
}

function requireId(id: string, label: string): void {
  if (!ID.test(id)) {
    throw new Error(`Invalid ${label}.`);
  }
}

function safeRelative(relative: string): string {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes("\0")
  ) {
    throw new Error("Unsafe snapshot path.");
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Unsafe snapshot path.");
  }
  return relative;
}

function safeWorkspaceRelative(relative: string): string {
  safeRelative(relative);
  if (
    relative
      .split("/")
      .some(
        (part) =>
          part === ".git" ||
          /^\.env(?:\.|$)/.test(part) ||
          /^(?:id_rsa|id_ed25519|secrets\.json)$/.test(part),
      )
  ) {
    throw new Error(`Workspace contains a Git control or credential-shaped path: ${relative}`);
  }
  return relative;
}

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function filesUnder(root: string): Promise<readonly string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Snapshot cannot include symbolic link: ${absolute}`);
      }
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        output.push(absolute);
      } else {
        throw new Error(`Snapshot cannot include special file: ${absolute}`);
      }
      if (output.length > MAX_FILES) {
        throw new Error("Snapshot has too many files.");
      }
    }
  };
  await visit(root);
  return output;
}

/** Tracked and non-ignored untracked files only; Git metadata and ignored secrets stay local. */
async function gitWorkspaceFiles(root: string): Promise<readonly string[]> {
  const { stdout: topLevel } = await execFileAsync("git", [
    "-C",
    root,
    "rev-parse",
    "--show-toplevel",
  ]);
  if ((await fs.realpath(topLevel.trim())) !== root) {
    throw new Error("Workspace root must be the Git repository root.");
  }
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const relativeFiles = stdout.toString("utf8").split("\0").filter(Boolean);
  if (relativeFiles.length > MAX_FILES) {
    throw new Error("Snapshot has too many files.");
  }
  const files: string[] = [];
  for (const relative of relativeFiles) {
    const normalized = relative.split(path.sep).join("/");
    safeWorkspaceRelative(normalized);
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Workspace contains a symbolic link or special file: ${relative}`);
    }
    files.push(absolute);
  }
  return files;
}

async function gitDeletedPaths(root: string): Promise<readonly string[]> {
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "--deleted", "-z"], {
    encoding: "buffer",
  });
  return stdout.toString("utf8").split("\0").filter(Boolean).map(safeWorkspaceRelative);
}

async function addFile(
  source: string,
  kind: DetachEntry["kind"],
  relativePath: string,
  bundleDirectory: string,
  entries: DetachEntry[],
  byteCount: { value: number },
): Promise<void> {
  safeRelative(relativePath);
  const stat = await fs.lstat(source);
  if (!stat.isFile()) {
    throw new Error(`Snapshot source is not a regular file: ${source}`);
  }
  byteCount.value += stat.size;
  if (byteCount.value > MAX_BYTES) {
    throw new Error("Snapshot exceeds the 1 GiB transfer limit.");
  }
  const destination = path.join(bundleDirectory, "files", relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination);
  entries.push({ kind, relativePath, size: stat.size, sha256: await digest(destination) });
}

async function addTree(
  sourceRoot: string,
  kind: DetachEntry["kind"],
  bundlePrefix: string,
  bundleDirectory: string,
  entries: DetachEntry[],
  byteCount: { value: number },
): Promise<void> {
  const stat = await fs.lstat(sourceRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!stat) {
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Snapshot source is not a directory: ${sourceRoot}`);
  }
  for (const file of await filesUnder(sourceRoot)) {
    const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
    await addFile(file, kind, `${bundlePrefix}/${relative}`, bundleDirectory, entries, byteCount);
  }
}

/**
 * Every user skill travels, since the agent may load any of them. A top-level skill that is a
 * symlink (as skill installers create) is copied from its target; links inside a skill are
 * still refused.
 */
async function addSkills(
  skillsRoot: string,
  bundleDirectory: string,
  entries: DetachEntry[],
  byteCount: { value: number },
): Promise<void> {
  const names = await fs.readdir(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [] as string[];
    }
    throw error;
  });
  for (const name of names.sort()) {
    if (name.startsWith(".")) {
      continue;
    }
    const source = await fs.realpath(path.join(skillsRoot, name));
    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      await addTree(source, "skill", `jazz/skills/${name}`, bundleDirectory, entries, byteCount);
    } else if (stat.isFile()) {
      await addFile(source, "skill", `jazz/skills/${name}`, bundleDirectory, entries, byteCount);
    }
  }
}

/** A custom persona travels with the agent that uses it; built-ins already exist remotely. */
async function addPersona(
  persona: string,
  jazzHome: string,
  bundleDirectory: string,
  entries: DetachEntry[],
  byteCount: { value: number },
): Promise<void> {
  const builtinName = persona.startsWith("builtin-") ? persona.slice("builtin-".length) : persona;
  if ((BUILTIN_PERSONA_NAMES as readonly string[]).includes(builtinName.toLowerCase())) {
    return;
  }
  if (!ID.test(persona)) {
    throw new Error(`Persona ${persona} cannot be located for transfer.`);
  }
  const directory = path.join(jazzHome, "personas", persona);
  if (!(await fs.stat(directory).catch(() => undefined))?.isDirectory()) {
    throw new Error(
      `Persona ${persona} is not in ${path.join(jazzHome, "personas")}; plugin personas do not travel.`,
    );
  }
  await addTree(
    directory,
    "persona",
    `jazz/personas/${persona}`,
    bundleDirectory,
    entries,
    byteCount,
  );
}

/** Save any in-memory turn strictly, then build a transfer directory and manifest. */
export async function createDetachSnapshot(
  input: CreateDetachSnapshotInput,
): Promise<DetachManifest> {
  requireId(input.agentId, "agent id");
  requireId(input.conversationId, "conversation id");
  requireId(input.handoffId, "handoff id");
  const workspaceRoot = await fs.realpath(input.workspaceRoot);
  if (!(await fs.stat(workspaceRoot)).isDirectory()) {
    throw new Error("Workspace root must be a directory.");
  }
  const bundleDirectory = path.resolve(input.bundleDirectory);
  if (
    bundleDirectory === workspaceRoot ||
    bundleDirectory.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error("Snapshot destination must be outside the workspace.");
  }
  const prior = await Effect.runPromise(
    loadConversation(input.agentId, input.conversationId).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  if (input.history !== undefined) {
    const conversation: Conversation = {
      agentId: input.agentId,
      conversationId: input.conversationId,
      title: prior?.title ?? "",
      startedAt: prior?.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      messages: [...input.history],
      ...(prior?.uiTranscript !== undefined ? { uiTranscript: prior.uiTranscript } : {}),
    };
    await Effect.runPromise(
      saveConversation(conversation).pipe(Effect.provide(NodeFileSystem.layer)),
    );
  }
  const history = await Effect.runPromise(
    loadConversation(input.agentId, input.conversationId).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
  if (!history) {
    throw new Error("Conversation has no persisted history to detach.");
  }
  const localHome = getJazzHomeDirectory();
  const serializedHistory = JSON.stringify(history.messages);
  if (
    serializedHistory.includes(path.join(localHome, "generated")) ||
    serializedHistory.includes(path.join(localHome, "compositions"))
  ) {
    throw new Error("This conversation references generated artifacts that are not portable yet.");
  }
  await fs.mkdir(bundleDirectory, { recursive: true, mode: 0o700 });
  const entries: DetachEntry[] = [];
  const byteCount = { value: 0 };
  const historyFile = path.join(bundleDirectory, "conversation.json");
  await fs.writeFile(historyFile, `${JSON.stringify(history)}\n`, { mode: 0o600 });
  await addFile(historyFile, "history", "conversation.json", bundleDirectory, entries, byteCount);
  await fs.rm(historyFile);
  const jazzHome = getJazzHomeDirectory();
  await addSkills(path.join(jazzHome, "skills"), bundleDirectory, entries, byteCount);
  const gitBundle = path.join(bundleDirectory, "repository.bundle");
  await execFileAsync("git", ["-C", workspaceRoot, "bundle", "create", gitBundle, "HEAD"]);
  await addFile(gitBundle, "git", "git/repository.bundle", bundleDirectory, entries, byteCount);
  await fs.rm(gitBundle);
  for (const file of await gitWorkspaceFiles(workspaceRoot)) {
    const relative = path.relative(workspaceRoot, file).split(path.sep).join("/");
    await addFile(file, "workspace", `workspace/${relative}`, bundleDirectory, entries, byteCount);
  }
  await addTree(
    path.join(jazzHome, "work", input.agentId, input.conversationId),
    "work",
    `jazz/work/${input.agentId}/${input.conversationId}`,
    bundleDirectory,
    entries,
    byteCount,
  );
  const agentPath = path.join(jazzHome, "agents", `${input.agentId}.json`);
  if (await fs.stat(agentPath).catch(() => undefined)) {
    const agent: unknown = JSON.parse(await fs.readFile(agentPath, "utf8"));
    if (
      typeof agent !== "object" ||
      agent === null ||
      !("config" in agent) ||
      typeof agent.config !== "object" ||
      agent.config === null
    ) {
      throw new Error("Agent configuration is invalid.");
    }
    const clean = structuredClone(agent) as { config: Record<string, unknown> };
    delete clean.config["llmApiKeys"];
    const persona = clean.config["persona"];
    if (typeof persona === "string") {
      await addPersona(persona, jazzHome, bundleDirectory, entries, byteCount);
    }
    const staged = path.join(bundleDirectory, "agent.json");
    await fs.writeFile(staged, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    await addFile(
      staged,
      "config",
      `jazz/agents/${input.agentId}.json`,
      bundleDirectory,
      entries,
      byteCount,
    );
    await fs.rm(staged);
  }
  const todo = path.join(os.tmpdir(), `jazz-todos-${input.conversationId}.json`);
  if (await fs.stat(todo).catch(() => undefined)) {
    await addFile(todo, "todos", "todos.json", bundleDirectory, entries, byteCount);
  }
  const manifest: DetachManifest = {
    version: 1,
    handoffId: input.handoffId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    workspaceRoot,
    deletedPaths: await gitDeletedPaths(workspaceRoot),
    entries,
  };
  await fs.writeFile(
    path.join(bundleDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

function parseManifest(value: unknown): DetachManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid detach manifest.");
  }
  const input = value as Record<string, unknown>;
  if (
    input["version"] !== 1 ||
    typeof input["agentId"] !== "string" ||
    typeof input["conversationId"] !== "string" ||
    typeof input["handoffId"] !== "string" ||
    typeof input["workspaceRoot"] !== "string" ||
    !Array.isArray(input["entries"]) ||
    !Array.isArray(input["deletedPaths"])
  ) {
    throw new Error("Invalid detach manifest.");
  }
  requireId(input["agentId"], "agent id");
  requireId(input["conversationId"], "conversation id");
  requireId(input["handoffId"], "handoff id");
  const entries: DetachEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input["entries"]) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("Invalid detach entry.");
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry["relativePath"] !== "string" ||
      typeof entry["sha256"] !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry["sha256"]) ||
      typeof entry["size"] !== "number" ||
      !Number.isSafeInteger(entry["size"]) ||
      entry["size"] < 0 ||
      ![
        "history",
        "work",
        "todos",
        "artifact",
        "workspace",
        "config",
        "git",
        "skill",
        "persona",
      ].includes(String(entry["kind"]))
    ) {
      throw new Error("Invalid detach entry.");
    }
    safeRelative(entry["relativePath"]);
    const relative = entry["relativePath"];
    const kind = entry["kind"];
    if (
      (kind === "history" && relative !== "conversation.json") ||
      (kind === "git" && relative !== "git/repository.bundle") ||
      (kind === "todos" && relative !== "todos.json") ||
      (kind === "workspace" && !relative.startsWith("workspace/")) ||
      (kind === "work" &&
        !relative.startsWith(`jazz/work/${input["agentId"]}/${input["conversationId"]}/`)) ||
      (kind === "config" && relative !== `jazz/agents/${input["agentId"]}.json`) ||
      (kind === "skill" && !relative.startsWith("jazz/skills/")) ||
      (kind === "persona" && !relative.startsWith("jazz/personas/")) ||
      kind === "artifact"
    ) {
      throw new Error("Entry kind and path do not match.");
    }
    if (kind === "workspace") {
      safeWorkspaceRelative(relative.slice("workspace/".length));
    }
    if (seen.has(entry["relativePath"])) {
      throw new Error("Duplicate detach entry.");
    }
    seen.add(entry["relativePath"]);
    entries.push(entry as unknown as DetachEntry);
  }
  if (entries.length > MAX_FILES || entries.reduce((n, entry) => n + entry.size, 0) > MAX_BYTES) {
    throw new Error("Snapshot exceeds transfer limits.");
  }
  if (
    entries.filter((entry) => entry.kind === "history").length !== 1 ||
    entries.filter((entry) => entry.kind === "git").length !== 1
  ) {
    throw new Error("Snapshot is missing required entries.");
  }
  const deletedPaths = input["deletedPaths"] as unknown[];
  if (
    !deletedPaths.every(
      (item): item is string => typeof item === "string" && safeWorkspaceRelative(item) === item,
    )
  ) {
    throw new Error("Invalid deleted path.");
  }
  return {
    version: 1,
    handoffId: input["handoffId"],
    agentId: input["agentId"],
    conversationId: input["conversationId"],
    workspaceRoot: input["workspaceRoot"],
    deletedPaths,
    entries,
  };
}

async function readVerifiedBundle(bundlePath: string): Promise<{
  readonly manifest: DetachManifest;
  readonly verified: readonly { readonly entry: DetachEntry; readonly source: string }[];
}> {
  const bundleDirectory = await fs.realpath(bundlePath);
  const manifest = parseManifest(
    JSON.parse(await fs.readFile(path.join(bundleDirectory, "manifest.json"), "utf8")) as unknown,
  );
  const verified: { entry: DetachEntry; source: string }[] = [];
  for (const entry of manifest.entries) {
    const source = path.join(bundleDirectory, "files", entry.relativePath);
    const stat = await fs.lstat(source);
    const canonical = await fs.realpath(source);
    if (!canonical.startsWith(`${bundleDirectory}${path.sep}`)) {
      throw new Error("Snapshot entry escapes bundle.");
    }
    if (!stat.isFile() || stat.size !== entry.size || (await digest(source)) !== entry.sha256) {
      throw new Error(`Snapshot verification failed: ${entry.relativePath}`);
    }
    verified.push({ entry, source });
  }
  return { manifest, verified };
}

/** Read and hash every declared file without changing the bundle or local Jazz state. */
export async function verifyDetachSnapshot(bundleDirectory: string): Promise<DetachManifest> {
  return (await readVerifiedBundle(bundleDirectory)).manifest;
}

/** Verify the complete bundle, then restore it into a dedicated destination. */
export async function importDetachSnapshot(input: {
  readonly bundleDirectory: string;
  readonly workspaceRoot: string;
}): Promise<DetachManifest> {
  const { manifest, verified } = await readVerifiedBundle(input.bundleDirectory);
  const historyEntry = verified.find(
    ({ entry }) => entry.kind === "history" && entry.relativePath === "conversation.json",
  );
  if (!historyEntry) {
    throw new Error("Snapshot has no conversation history.");
  }
  const gitEntry = verified.find(
    ({ entry }) => entry.kind === "git" && entry.relativePath === "git/repository.bundle",
  );
  if (!gitEntry) {
    throw new Error("Snapshot has no Git repository bundle.");
  }
  const history: unknown = JSON.parse(await fs.readFile(historyEntry.source, "utf8"));
  if (
    typeof history !== "object" ||
    history === null ||
    !Array.isArray((history as Conversation).messages) ||
    (history as Conversation).agentId !== manifest.agentId ||
    (history as Conversation).conversationId !== manifest.conversationId
  ) {
    throw new Error("Snapshot conversation identity mismatch.");
  }
  const workspaceRoot = path.resolve(input.workspaceRoot);
  if ((await fs.lstat(workspaceRoot).catch(() => undefined))?.isSymbolicLink()) {
    throw new Error("Workspace destination is a symbolic link.");
  }
  if ((await fs.lstat(getJazzHomeDirectory()).catch(() => undefined))?.isSymbolicLink()) {
    throw new Error("Jazz home is a symbolic link.");
  }
  if (
    await fs
      .readdir(workspaceRoot)
      .catch(() => [] as string[])
      .then((names) => names.length > 0)
  ) {
    throw new Error("Remote workspace must be empty.");
  }
  await execFileAsync("git", ["clone", "-q", gitEntry.source, workspaceRoot]);
  await filesUnder(workspaceRoot);
  for (const relative of manifest.deletedPaths) {
    await fs.rm(path.join(workspaceRoot, relative), { force: true });
  }
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const destinations = verified
    .filter(({ entry }) => entry.kind !== "history" && entry.kind !== "git")
    .map(({ entry, source }) => {
      const relative = entry.relativePath;
      if (entry.kind === "workspace" && !relative.startsWith("workspace/")) {
        throw new Error("Invalid workspace entry.");
      }
      if (
        entry.kind === "work" &&
        !relative.startsWith(`jazz/work/${manifest.agentId}/${manifest.conversationId}/`)
      ) {
        throw new Error("Invalid work entry.");
      }
      if (entry.kind === "artifact" && !relative.startsWith("jazz/generated/")) {
        throw new Error("Invalid artifact entry.");
      }
      if (
        (entry.kind === "config" || entry.kind === "skill" || entry.kind === "persona") &&
        !relative.startsWith("jazz/")
      ) {
        throw new Error("Invalid Jazz data entry.");
      }
      const destination =
        entry.kind === "workspace"
          ? path.join(workspaceRoot, relative.slice("workspace/".length))
          : entry.kind === "todos"
            ? path.join(temporaryRoot, `jazz-todos-${manifest.conversationId}.json`)
            : path.join(getJazzHomeDirectory(), relative.slice("jazz/".length));
      const boundary =
        entry.kind === "workspace"
          ? workspaceRoot
          : entry.kind === "todos"
            ? temporaryRoot
            : getJazzHomeDirectory();
      return { destination, source, boundary, entry };
    });
  /**
   * The source machine owns the agent config and this conversation's work journal, so a later
   * handoff of the same agent or conversation replaces the host's copies. Skills and personas
   * are shared by every handoff on the host, so only an identical copy is accepted.
   */
  const workRoot = path.join(
    getJazzHomeDirectory(),
    "work",
    manifest.agentId,
    manifest.conversationId,
  );
  const unchanged = new Set<string>();
  for (const { destination, boundary, entry } of destinations) {
    const existing = await fs.lstat(destination).catch(() => undefined);
    const shared = entry.kind === "skill" || entry.kind === "persona";
    const replaceable =
      (entry.kind === "config" && existing?.isFile() === true) || entry.kind === "work";
    if (existing && shared && existing.isFile() && (await digest(destination)) === entry.sha256) {
      unchanged.add(destination);
    } else if (existing && shared) {
      throw new Error(
        `A different ${entry.kind} already exists on this host: ${entry.relativePath.slice("jazz/".length)}`,
      );
    } else if (
      existing &&
      !replaceable &&
      (destination.startsWith(`${getJazzHomeDirectory()}${path.sep}`) || !existing.isFile())
    ) {
      throw new Error(`Destination already exists: ${destination}`);
    }
    let ancestor = path.dirname(destination);
    while (ancestor !== boundary) {
      const stat = await fs.lstat(ancestor).catch(() => undefined);
      if (stat?.isSymbolicLink()) {
        throw new Error(`Destination has a symbolic link: ${ancestor}`);
      }
      ancestor = path.dirname(ancestor);
    }
  }
  if ((await fs.lstat(workRoot).catch(() => undefined))?.isSymbolicLink()) {
    throw new Error(`Destination has a symbolic link: ${workRoot}`);
  }
  await fs.rm(workRoot, { recursive: true, force: true });
  for (const { destination, source } of destinations) {
    if (unchanged.has(destination)) {
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(source, destination);
    await fs.chmod(destination, 0o600);
  }
  await Effect.runPromise(
    saveConversation(history as Conversation).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  return manifest;
}

export interface DetachWorkspaceDiff {
  readonly changedPaths: readonly string[];
  /** Changed remotely, and locally now matching neither the handed-off nor the remote bytes. */
  readonly conflicts: readonly string[];
}

async function currentHash(file: string): Promise<string | undefined> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat) {
    return undefined;
  }
  return stat.isFile() ? digest(file) : "non-regular";
}

function workspaceHashes(manifest: DetachManifest): Map<string, string> {
  return new Map(
    manifest.entries
      .filter((entry) => entry.kind === "workspace")
      .map((entry) => [entry.relativePath.slice("workspace/".length), entry.sha256]),
  );
}

/** Compare the handed-off workspace with the remote result and with the local tree today. */
export async function compareDetachWorkspaces(
  initial: DetachManifest,
  result: DetachManifest,
): Promise<DetachWorkspaceDiff> {
  const before = workspaceHashes(initial);
  const after = workspaceHashes(result);
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((relative) => before.get(relative) !== after.get(relative))
    .sort();
  const conflicts: string[] = [];
  for (const relative of changedPaths) {
    const current = await currentHash(path.join(initial.workspaceRoot, relative));
    if (current !== before.get(relative) && current !== after.get(relative)) {
      conflicts.push(relative);
    }
  }
  return { changedPaths, conflicts };
}

async function assertNoSymlinkAncestor(destination: string, boundary: string): Promise<void> {
  let ancestor = path.dirname(destination);
  while (ancestor !== boundary && ancestor.startsWith(`${boundary}${path.sep}`)) {
    if ((await fs.lstat(ancestor).catch(() => undefined))?.isSymbolicLink()) {
      throw new Error(`Destination has a symbolic link: ${ancestor}`);
    }
    ancestor = path.dirname(ancestor);
  }
}

async function replaceFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.jazz-reclaim-${process.pid}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export interface ApplyDetachResultOutcome extends DetachWorkspaceDiff {
  readonly applied: boolean;
}

/**
 * Bring a released remote conversation home: the workspace changes the remote made, then its
 * transcript, work journal and todos. Nothing is written while a conflict remains unless the
 * caller chose to let remote bytes win. Remote skills, personas and agent config stay remote.
 */
export async function applyDetachResult(input: {
  readonly initialDirectory: string;
  readonly resultDirectory: string;
  readonly overwriteConflicts: boolean;
}): Promise<ApplyDetachResultOutcome> {
  const { manifest: initial, verified: initialVerified } = await readVerifiedBundle(
    input.initialDirectory,
  );
  const { manifest: result, verified } = await readVerifiedBundle(input.resultDirectory);
  if (
    result.handoffId !== initial.handoffId ||
    result.agentId !== initial.agentId ||
    result.conversationId !== initial.conversationId
  ) {
    throw new Error("Result identity does not match the original handoff.");
  }
  const diff = await compareDetachWorkspaces(initial, result);
  if (diff.conflicts.length > 0 && !input.overwriteConflicts) {
    return { ...diff, applied: false };
  }
  const sources = new Map(verified.map(({ entry, source }) => [entry.relativePath, source]));
  const historySource = sources.get("conversation.json");
  if (historySource === undefined) {
    throw new Error("Result has no conversation history.");
  }
  const history = await readConversationEntry(historySource, initial);
  const initialHistorySource = initialVerified.find(
    ({ entry }) => entry.relativePath === "conversation.json",
  )?.source;
  if (initialHistorySource === undefined) {
    throw new Error("Original handoff has no conversation history.");
  }
  const handedOff = await readConversationEntry(initialHistorySource, initial);

  const workspaceRoot = await fs.realpath(initial.workspaceRoot);
  for (const relative of diff.changedPaths) {
    const destination = path.join(workspaceRoot, relative);
    await assertNoSymlinkAncestor(destination, workspaceRoot);
    const source = sources.get(`workspace/${relative}`);
    if (source === undefined) {
      await fs.rm(destination, { force: true });
    } else {
      await replaceFile(source, destination);
    }
  }

  const jazzHome = getJazzHomeDirectory();
  const workPrefix = `jazz/work/${initial.agentId}/${initial.conversationId}/`;
  const workRoot = path.join(jazzHome, "work", initial.agentId, initial.conversationId);
  await fs.rm(workRoot, { recursive: true, force: true });
  for (const { entry, source } of verified) {
    if (entry.kind === "work" && entry.relativePath.startsWith(workPrefix)) {
      const destination = path.join(workRoot, entry.relativePath.slice(workPrefix.length));
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.copyFile(source, destination);
      await fs.chmod(destination, 0o600);
    }
  }
  const todoSource = sources.get("todos.json");
  if (todoSource !== undefined) {
    await replaceFile(
      todoSource,
      path.join(await fs.realpath(os.tmpdir()), `jazz-todos-${initial.conversationId}.json`),
    );
  }
  await Effect.runPromise(
    saveConversation(withRemoteTurnsInUiTranscript(handedOff, history), undefined, {
      fenceHeldBy: initial.handoffId,
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
  return { ...diff, applied: true };
}

async function readConversationEntry(
  source: string,
  manifest: DetachManifest,
): Promise<Conversation> {
  const history: unknown = JSON.parse(await fs.readFile(source, "utf8"));
  if (
    typeof history !== "object" ||
    history === null ||
    !Array.isArray((history as Conversation).messages) ||
    (history as Conversation).agentId !== manifest.agentId ||
    (history as Conversation).conversationId !== manifest.conversationId
  ) {
    throw new Error("Conversation identity mismatch.");
  }
  return history as Conversation;
}

/**
 * A resumed chat paints the saved UI transcript when there is one, and that transcript stops
 * at the handoff. Append the remote turns so they show up; if the remote rewrote history
 * (compaction), drop the stale transcript and let resume paint from messages instead.
 */
export function withRemoteTurnsInUiTranscript(
  handedOff: Conversation,
  returned: Conversation,
): Conversation {
  if (returned.uiTranscript === undefined) {
    return returned;
  }
  const shared = handedOff.messages.length;
  const continues =
    returned.messages.length >= shared &&
    handedOff.messages.every(
      (message, index) =>
        returned.messages[index]?.role === message.role &&
        returned.messages[index]?.content === message.content,
    );
  if (!continues) {
    const { uiTranscript: _stale, ...rest } = returned;
    return rest;
  }
  const remoteTurns = returned.messages.slice(shared).flatMap((message) =>
    (message.role === "user" || message.role === "assistant") &&
    message.kind !== "continuation" &&
    message.content.trim().length > 0
      ? [
          {
            type: message.role === "user" ? ("user" as const) : ("streamContent" as const),
            message: message.content,
          },
        ]
      : [],
  );
  return {
    ...returned,
    uiTranscript: [
      ...returned.uiTranscript,
      { type: "info", message: "Continued on a remote host" },
      ...remoteTurns,
    ],
  };
}

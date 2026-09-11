/**
 * Per-conversation OS sandboxes for the bot bridges.
 *
 * A bridge runs every conversation's agent as the same process user, so the
 * only thing keeping one person's memory, history, stored secrets and mail
 * credentials away from another's is a filename prefix. Any tool call the
 * agent makes — `read_file`, `execute_command` — steps straight past a naming
 * convention, so a second allowlisted person's agent can read everything the
 * first one has.
 *
 * This module hands each conversation its own uid and its own `JAZZ_HOME`, so
 * the kernel enforces the split instead of the filenames: an agent run for one
 * conversation cannot open another conversation's files at all.
 *
 * Layout, with `O` the operator group — the group that owns the data
 * directory, and the only identity meant to read everything:
 *
 *   <dataDir>              root:O  2751   bridge-only stores; traversable, not listable
 *   <dataDir>/chats        root:O  2751   traversable, not listable
 *   <dataDir>/chats/<id>   uid:O   2750   one conversation's entire Jazz home
 *
 * Files written inside a conversation home land as `uid:O 0640`: the setgid
 * bit stamps the operator group onto them and the inherited umask drops the
 * world bits. A conversation's uid is deliberately not a member of `O`, so
 * "everyone else" means no access for it, while a human in `O` reads the lot.
 *
 * Sandboxing needs CAP_SETUID, so it engages only when the bridge runs as
 * root. Anywhere else — a dev machine, the test suite — every conversation
 * keeps using the shared data directory exactly as it did before.
 */

import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { applyBridgeConfigFile } from "./bridge-config-file";

/** Directory under the data dir holding one Jazz home per conversation. */
const SANDBOX_DIRECTORY = "chats";
/** Conversation id → uid, persisted so a container rebuild keeps the same owners. */
const UID_MAP_FILE = ".uid-map.json";
/**
 * First uid handed to a conversation. Debian's own `useradd` allocates system
 * accounts below 1000 and human ones from 1000, and its `UID_MAX` default
 * stops at 60000, so starting above that keeps conversation uids out of any
 * range the distribution assigns on its own.
 */
const FIRST_SANDBOX_UID = 70_000;
/** `rwxr-s--x`: enter a known path, but no listing and no writing. */
const TRAVERSABLE_MODE = 0o2751;
/** `rwxr-s---`: the conversation owns it, the operator group reads it, nobody else. */
const SANDBOX_HOME_MODE = 0o2750;
/** Drops the world bits off everything the bridge and its agents create. */
export const SANDBOX_UMASK = 0o027;

export interface ChatSandbox {
  /** `JAZZ_HOME` for this conversation's agent runs. */
  readonly home: string;
  /** uid the agent runs as, or `null` when sandboxing is off. */
  readonly uid: number | null;
  /** Operator group stamped onto everything written in `home`. */
  readonly gid: number | null;
  readonly isolated: boolean;
}

function isDisabledFlag(raw: string): boolean {
  return ["0", "false", "off", "no"].includes(raw);
}

function isEnabledFlag(raw: string): boolean {
  return ["1", "true", "on", "yes"].includes(raw);
}

let isolationDecision: boolean | undefined;

/**
 * Whether per-conversation sandboxes are in force.
 *
 * Requires root: dropping to another uid per run is a privileged operation, and
 * `setpriv` is what performs it. `JAZZ_BOT_CHAT_ISOLATION=0` turns it off even
 * when both are available.
 */
export function chatIsolationEnabled(): boolean {
  if (isolationDecision !== undefined) return isolationDecision;

  const flag = process.env["JAZZ_BOT_CHAT_ISOLATION"]?.trim().toLowerCase() ?? "";
  if (isDisabledFlag(flag)) {
    isolationDecision = false;
    return isolationDecision;
  }

  const missing = missingIsolationRequirement();
  if (missing !== null) {
    if (isEnabledFlag(flag)) {
      console.error(
        `JAZZ_BOT_CHAT_ISOLATION is on but ${missing}. Every conversation will share one data directory and one uid.`,
      );
    }
    isolationDecision = false;
    return isolationDecision;
  }

  isolationDecision = true;
  return isolationDecision;
}

function missingIsolationRequirement(): string | null {
  if (process.getuid?.() !== 0) return "the bridge is not running as root, so it cannot change uid";
  if (Bun.which("setpriv") === null) return "`setpriv` is not installed in this image";
  if (Bun.which("useradd") === null) return "`useradd` is not installed in this image";
  if (Bun.which("chmod") === null) return "`chmod` is not installed in this image";
  return null;
}

/** Test seam: forget the memoized decision so a changed environment is re-read. */
export function resetChatIsolationDecision(): void {
  isolationDecision = undefined;
}

export function sandboxDirectory(dataDir: string): string {
  return join(dataDir, SANDBOX_DIRECTORY);
}

/**
 * Where a conversation's Jazz home is, without creating or touching anything.
 *
 * Returns the shared data directory when sandboxing is off, so callers that
 * only need a path behave exactly as they did before sandboxes existed.
 */
export function chatHome(dataDir: string, agentId: string): string {
  if (!chatIsolationEnabled()) return dataDir;
  return join(sandboxDirectory(dataDir), agentId);
}

/**
 * The operator group: the identity allowed to read every conversation's state.
 *
 * Defaults to the group owning the data directory, so a bind mount created as
 * `chown root:<operator group>` is the whole configuration. `JAZZ_BOT_OPERATOR_GID`
 * overrides it for mounts whose group cannot be set (a plain Docker named
 * volume is `root:root`).
 */
export function operatorGid(dataDir: string): number {
  const configured = Number.parseInt(process.env["JAZZ_BOT_OPERATOR_GID"]?.trim() ?? "", 10);
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return statSync(dataDir).gid;
}

type UidMap = Record<string, number>;

function uidMapPath(dataDir: string): string {
  return join(sandboxDirectory(dataDir), UID_MAP_FILE);
}

function readUidMap(dataDir: string): UidMap {
  const path = uidMapPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: UidMap = {};
    for (const [agentId, uid] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof uid === "number" && Number.isInteger(uid)) map[agentId] = uid;
    }
    return map;
  } catch {
    // A hand-mangled map must not silently re-allocate uids over existing
    // homes, so refuse rather than start from empty.
    throw new Error(`${path} is not a readable uid map; fix or remove it before starting.`);
  }
}

function writeUidMap(dataDir: string, map: UidMap): void {
  const path = uidMapPath(dataDir);
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}

function nextUid(map: UidMap): number {
  const used = Object.values(map);
  return used.length === 0 ? FIRST_SANDBOX_UID : Math.max(...used) + 1;
}

/** Account name for a conversation uid. Kept short and shell-safe for `useradd`. */
function accountName(uid: number): string {
  return `jazzchat${uid - FIRST_SANDBOX_UID}`;
}

function run(command: string[]): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, stderr: new TextDecoder().decode(result.stderr).trim() };
}

/**
 * Make sure `uid` resolves to a real account.
 *
 * `setpriv` happily switches to a uid with no passwd entry, but tools the agent
 * shells out to (git, gpg, ssh) call `getpwuid` and fail outright when it comes
 * back empty. `/etc` lives on the container's writable layer, so the accounts
 * are recreated from the persisted uid map after every rebuild.
 */
function ensureAccount(uid: number): void {
  if (run(["getent", "passwd", String(uid)]).ok) return;
  const name = accountName(uid);
  // A private primary group, never the operator group: a conversation that
  // shared the operator group would read every other conversation's files
  // through the group bits that exist for the human operator.
  if (!run(["getent", "group", String(uid)]).ok) {
    const group = run(["groupadd", "--gid", String(uid), name]);
    if (!group.ok) throw new Error(`Could not create group ${name} (${uid}): ${group.stderr}`);
  }
  const user = run([
    "useradd",
    "--no-create-home",
    "--uid",
    String(uid),
    "--gid",
    String(uid),
    "--shell",
    "/usr/sbin/nologin",
    name,
  ]);
  if (!user.ok) throw new Error(`Could not create account ${name} (${uid}): ${user.stderr}`);
}

/**
 * `chmod` that keeps the setgid bit.
 *
 * Bun's `fs.chmodSync` masks a mode down to the nine permission bits, so 2750
 * lands as 750. That failure is silent and it is the one that matters here:
 * without setgid on a conversation's directories, the files its agent creates
 * are grouped to the conversation instead of the operator, and the human who
 * is supposed to be able to read everything can read none of it. The coreutils
 * binary applies the mode as given.
 */
export function setMode(path: string, mode: number): void {
  if ((mode & ~0o777) === 0) {
    chmodSync(path, mode);
    return;
  }
  const octal = mode.toString(8).padStart(4, "0");
  const result = Bun.spawnSync(["chmod", octal, path], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not set mode ${octal} on ${path}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

function ensureDirectory(path: string, uid: number, gid: number, mode: number): void {
  mkdirSync(path, { recursive: true });
  // chown(2) clears setgid, so the mode goes on afterwards.
  chownSync(path, uid, gid);
  setMode(path, mode);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Expose a shared, read-only directory inside a conversation home.
 *
 * Personas are the one thing every conversation is meant to see the same copy
 * of, and the marketplace installs them into the data directory as root, so a
 * symlink beats a per-conversation copy that would go stale on the next
 * install.
 */
function linkShared(home: string, name: string, target: string): void {
  const path = join(home, name);
  if (exists(path) || !existsSync(target)) return;
  try {
    symlinkSync(target, path);
  } catch (error) {
    console.error(`Could not link ${name} into ${home}: ${String(error)}`);
  }
}

/**
 * Give the conversation its own `config.json`, carrying the bridge-managed
 * keys.
 *
 * Re-merged on every call rather than copied once, so an operator who turns
 * Brave search on or changes Ollama's keep-alive sees it in every conversation
 * on the next restart — while whatever the conversation itself put in the file
 * (an "Always allow" for a shell command, say) survives, because that is what
 * the merge rule is for.
 */
function seedConfig(home: string, uid: number, gid: number): void {
  const path = join(home, "config.json");
  applyBridgeConfigFile(path);
  chownSync(path, uid, gid);
  chmodSync(path, 0o600);
}

const provisioned = new Map<string, ChatSandbox>();

/** Test seam: forget which sandboxes this process has already provisioned. */
export function resetProvisionedSandboxes(): void {
  provisioned.clear();
}

/**
 * Ensure a conversation has a sandbox, creating its uid and home on first use.
 *
 * Called on every incoming message, and provisioning means a `useradd`, a
 * `chmod` per directory and a config merge — so it runs once per conversation
 * per process and is a map lookup after that. A restart is what re-applies the
 * bridge-managed config keys and repairs modes, which is also when an operator
 * who changed them expects to see it.
 */
export function ensureChatSandbox(dataDir: string, agentId: string): ChatSandbox {
  if (!chatIsolationEnabled()) {
    return { home: dataDir, uid: null, gid: null, isolated: false };
  }

  // A child process inherits the umask, and that is the only thing keeping the
  // world bits off what an agent writes — `setpriv` has no way to set one. Any
  // entry point that reaches a sandbox comes through here, so it is set here
  // rather than left to whichever script happened to start the process.
  process.umask(SANDBOX_UMASK);

  const cacheKey = `${dataDir}\u0000${agentId}`;
  const alreadyProvisioned = provisioned.get(cacheKey);
  if (alreadyProvisioned !== undefined) return alreadyProvisioned;

  const gid = operatorGid(dataDir);
  const root = sandboxDirectory(dataDir);
  // The conversation uids are not in the operator group, so both of these have
  // to stay traversable or an agent cannot reach its own home. Neither is
  // readable: `chats/` never lists, and the bridge's own stores next to it
  // stay 0640.
  setMode(dataDir, TRAVERSABLE_MODE);
  ensureDirectory(root, 0, gid, TRAVERSABLE_MODE);

  const map = readUidMap(dataDir);
  let uid = map[agentId];
  if (uid === undefined) {
    uid = nextUid(map);
    map[agentId] = uid;
    writeUidMap(dataDir, map);
  }
  ensureAccount(uid);

  const home = join(root, agentId);
  ensureDirectory(home, uid, gid, SANDBOX_HOME_MODE);
  // Seeded up front so the first run writes into directories that already
  // carry the setgid bit, rather than ones Jazz creates with a plain mode.
  for (const child of [
    "agents",
    "history",
    "memory",
    "workspace",
    "reminders",
    "webapps",
    "tg-media",
    "xdg-config",
    "xdg-data",
    "xdg-state",
    "xdg-cache",
    "tmp",
  ]) {
    ensureDirectory(join(home, child), uid, gid, SANDBOX_HOME_MODE);
  }
  // GnuPG refuses to use a home directory any group or other identity can
  // reach, so this one keeps the operator out too — an operator setting up mail
  // for a conversation does it through the container as root anyway.
  ensureDirectory(join(home, "gnupg"), uid, uid, 0o700);
  ensureDirectory(join(home, "password-store"), uid, gid, SANDBOX_HOME_MODE);
  linkShared(home, "personas", join(dataDir, "personas"));
  seedConfig(home, uid, gid);

  const sandbox: ChatSandbox = { home, uid, gid, isolated: true };
  provisioned.set(cacheKey, sandbox);
  return sandbox;
}

/**
 * Hand a file the bridge wrote inside a conversation home over to that
 * conversation.
 *
 * The bridge writes as root, so an agent file or a downloaded attachment would
 * otherwise land owned by root and stay unreadable to the very uid meant to
 * use it.
 */
export function adoptIntoSandbox(sandbox: ChatSandbox, ...paths: readonly string[]): void {
  if (!sandbox.isolated || sandbox.uid === null || sandbox.gid === null) return;
  for (const path of paths) {
    try {
      chownSync(path, sandbox.uid, sandbox.gid);
    } catch (error) {
      console.error(`Could not hand ${path} to uid ${String(sandbox.uid)}: ${String(error)}`);
    }
  }
}

/** Every conversation home that exists, newest allocation last. */
export function listChatSandboxes(dataDir: string): { agentId: string; home: string }[] {
  if (!chatIsolationEnabled()) return [];
  const root = sandboxDirectory(dataDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ agentId: entry.name, home: join(root, entry.name) }));
}

/** Wrap a command so it runs as the sandbox's uid with no supplementary groups. */
export function sandboxCommand(sandbox: ChatSandbox, command: string[]): string[] {
  if (!sandbox.isolated || sandbox.uid === null) return command;
  return [
    "setpriv",
    "--reuid",
    String(sandbox.uid),
    "--regid",
    String(sandbox.uid),
    "--clear-groups",
    "--",
    ...command,
  ];
}

/**
 * Environment for a sandboxed run: every path that defaults to `$HOME` or
 * `$JAZZ_HOME` is moved inside the conversation's own home.
 *
 * The mail, calendar, GPG and `pass` stores are here for the same reason as
 * Jazz's own state — they are the account credentials of whoever set them up,
 * and a second conversation has no business reading them.
 *
 * `surface` names the front door for whatever the spawned process records about
 * itself. A bot shells out to the same `jazz run` a terminal user invokes, so
 * without the marker the two are indistinguishable in any per-surface metric.
 */
export function sandboxEnv(
  sandbox: ChatSandbox,
  base: NodeJS.ProcessEnv,
  surface?: string,
): NodeJS.ProcessEnv {
  const withSurface = surface === undefined ? { ...base } : { ...base, JAZZ_SURFACE: surface };
  // Set whether or not the conversation gets its own uid: which data directory
  // the agent lives in is not an isolation question. The containerised bridges
  // never noticed, because their entrypoint already exports JAZZ_HOME=/data; a
  // native bridge inherits the operator's environment, where it is unset and
  // the run resolves their own Jazz home instead of the bridge's.
  const withHome = { ...withSurface, JAZZ_HOME: sandbox.home };
  if (!sandbox.isolated) return withHome;
  return {
    ...withHome,
    HOME: sandbox.home,
    XDG_CONFIG_HOME: join(sandbox.home, "xdg-config"),
    XDG_DATA_HOME: join(sandbox.home, "xdg-data"),
    XDG_STATE_HOME: join(sandbox.home, "xdg-state"),
    XDG_CACHE_HOME: join(sandbox.home, "xdg-cache"),
    GNUPGHOME: join(sandbox.home, "gnupg"),
    PASSWORD_STORE_DIR: join(sandbox.home, "password-store"),
    TMPDIR: join(sandbox.home, "tmp"),
  };
}

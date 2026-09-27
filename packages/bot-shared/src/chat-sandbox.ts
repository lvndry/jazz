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
  existsSync,
  lchownSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SPEND_LEDGER_ENV, SPEND_RECORDED_BY_PARENT } from "@jazz/core/spend/ceilings";
import { isRecord } from "@jazz/core/utils/is-record";
import { bridgeConfigContent } from "./bridge-config-file";
import { parseFlag } from "./bridge-env";
import { type ChildEnvOptions, childEnvironment } from "./child-env";
import { type FileOwner, type Ownership, type PinnedDirectory, withDirectory } from "./sandbox-fs";

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
/** `rwx------`: a directory only its owner enters (GnuPG insists). */
const PRIVATE_DIRECTORY_MODE = 0o700;
/** What the bridge writes for a conversation: its uid reads and writes, the operator reads. */
const SANDBOX_FILE_MODE = 0o640;
/** The conversation's `config.json` can carry keys, so the operator group is kept out too. */
const CONFIG_FILE_MODE = 0o600;
const CONFIG_FILE = "config.json";

/** The directories every conversation home starts with, all `uid:O 2750`. */
const SANDBOX_CHILD_DIRECTORIES = [
  "agents",
  "history",
  "memory",
  "workspace",
  "reminders",
  "compositions",
  "tg-media",
  "xdg-config",
  "xdg-data",
  "xdg-state",
  "xdg-cache",
  "tmp",
  "password-store",
] as const;

export interface ChatSandbox {
  /** `JAZZ_HOME` for this conversation's agent runs. */
  readonly home: string;
  /** uid the agent runs as, or `null` when sandboxing is off. */
  readonly uid: number | null;
  /** Operator group stamped onto everything written in `home`. */
  readonly gid: number | null;
  readonly isolated: boolean;
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

  const flag = parseFlag(process.env["JAZZ_BOT_CHAT_ISOLATION"]);
  if (flag === false) {
    isolationDecision = false;
    return isolationDecision;
  }

  const missing = missingIsolationRequirement();
  if (missing !== null) {
    if (flag === true) {
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
    if (!isRecord(parsed)) return {};
    const map: UidMap = {};
    for (const [agentId, uid] of Object.entries(parsed)) {
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

/**
 * Expose a shared, read-only directory inside a conversation home.
 *
 * Personas are the one thing every conversation is meant to see the same copy
 * of, and the library installs them into the data directory as root, so a
 * symlink beats a per-conversation copy that would go stale on the next
 * install.
 */
function linkShared(home: PinnedDirectory, name: string, target: string): void {
  if (!home.isAbsent(name) || !existsSync(target)) return;
  try {
    home.link(name, target);
  } catch (error) {
    console.error(`Could not link ${name} into ${home.path}: ${String(error)}`);
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
 *
 * Read without following a link and replaced by rename, so a conversation that
 * swaps its config for a symlink gets its own file back rather than having the
 * bridge write through the link as root.
 */
function seedConfig(home: PinnedDirectory, owner: FileOwner): void {
  const { content } = bridgeConfigContent(
    home.readText(CONFIG_FILE),
    `${home.path}/${CONFIG_FILE}`,
  );
  home.writeBytes(CONFIG_FILE, content, { owner, mode: CONFIG_FILE_MODE });
}

/** The config key an "Always allow" writes to, read by every later run of the conversation. */
const AUTO_APPROVED_COMMANDS_KEY = "autoApprovedCommands";

/**
 * Persist a command approval key to the conversation's `autoApprovedCommands`, so its later
 * runs (each a fresh process) run that command without asking.
 *
 * Read without following a link and replaced by rename, like the seeded config, and handed
 * back to the conversation's uid as it is written. A config that is not valid JSON is left
 * alone rather than overwritten.
 */
export function addAutoApprovedCommand(sandbox: ChatSandbox, commandKey: string): void {
  const ownership = sandboxOwnership(sandbox);
  withDirectory(sandbox.home, {}, (home) => {
    const raw = home.readText(CONFIG_FILE);
    let config: Record<string, unknown> = {};
    if (raw !== undefined) {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) {
        config = parsed;
      }
    }
    const existing = config[AUTO_APPROVED_COMMANDS_KEY];
    const current = Array.isArray(existing)
      ? existing.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (current.includes(commandKey)) return;
    config[AUTO_APPROVED_COMMANDS_KEY] = [...current, commandKey];
    home.writeBytes(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
      owner: ownership?.owner,
      mode: CONFIG_FILE_MODE,
    });
  });
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
  withDirectory(root, { create: { owner: { uid: 0, gid }, mode: TRAVERSABLE_MODE } }, () => {});

  const map = readUidMap(dataDir);
  let uid = map[agentId];
  if (uid === undefined) {
    uid = nextUid(map);
    map[agentId] = uid;
    writeUidMap(dataDir, map);
  }
  ensureAccount(uid);

  const home = join(root, agentId);
  const owner: FileOwner = { uid, gid };
  const directory = { create: { owner, mode: SANDBOX_HOME_MODE } };
  // Everything below `home` is a name the conversation controls, so it is all
  // reached through the pinned home and never by path.
  withDirectory(home, directory, (homeDirectory) => {
    // Seeded up front so the first run writes into directories that already
    // carry the setgid bit, rather than ones Jazz creates with a plain mode.
    for (const child of SANDBOX_CHILD_DIRECTORIES) {
      homeDirectory.directory(child, directory).close();
    }
    // GnuPG refuses to use a home directory any group or other identity can
    // reach, so this one keeps the operator out too — an operator setting up mail
    // for a conversation does it through the container as root anyway.
    homeDirectory
      .directory("gnupg", { create: { owner: { uid, gid: uid }, mode: PRIVATE_DIRECTORY_MODE } })
      .close();
    linkShared(homeDirectory, "personas", join(dataDir, "personas"));
    seedConfig(homeDirectory, owner);
  });

  const sandbox: ChatSandbox = { home, uid, gid, isolated: true };
  provisioned.set(cacheKey, sandbox);
  return sandbox;
}

/**
 * How files the bridge writes into this conversation's home are handed to it, or undefined
 * when the conversation runs as the bridge's own user and there is nobody to hand them to.
 */
export function sandboxOwnership(sandbox: ChatSandbox): Ownership | undefined {
  if (!sandbox.isolated || sandbox.uid === null || sandbox.gid === null) return undefined;
  return {
    owner: { uid: sandbox.uid, gid: sandbox.gid },
    directoryMode: SANDBOX_HOME_MODE,
    fileMode: SANDBOX_FILE_MODE,
  };
}

/**
 * Hand a file the bridge wrote inside a conversation home over to that
 * conversation.
 *
 * The bridge writes as root, so a downloaded attachment would otherwise land
 * owned by root and stay unreadable to the very uid meant to use it. `lchown`,
 * so a name the conversation swapped for a link changes the link and nothing it
 * points at.
 */
export function adoptIntoSandbox(sandbox: ChatSandbox, ...paths: readonly string[]): void {
  const owner = sandboxOwnership(sandbox)?.owner;
  if (owner === undefined) return;
  for (const path of paths) {
    try {
      lchownSync(path, owner.uid, owner.gid);
    } catch (error) {
      console.error(`Could not hand ${path} to uid ${String(owner.uid)}: ${String(error)}`);
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
 * {@link sandboxEnv} for a conversation's `jazz run`, whose cost the bridge records itself from
 * the run's envelope: the child is told not to record it again, so a bridge whose conversations
 * share its home (no per-conversation uid) counts each run once.
 */
export function bridgeRunEnv(
  sandbox: ChatSandbox,
  base: NodeJS.ProcessEnv,
  surface?: string,
): Record<string, string> {
  return { ...sandboxEnv(sandbox, base, surface), [SPEND_LEDGER_ENV]: SPEND_RECORDED_BY_PARENT };
}

/**
 * Environment for a run a bridge starts: the allowlist `childEnvironment` keeps, with every
 * path that defaults to `$HOME` or `$JAZZ_HOME` moved inside the conversation's own home.
 *
 * Built from an allowlist rather than a copy of `base`, so the bot token, a webhook secret and
 * any other credential the bridge holds never reach an agent that can run `env`.
 *
 * The mail, calendar, GPG and `pass` stores are moved for the same reason as Jazz's own state:
 * they are the account credentials of whoever set them up, and a second conversation has no
 * business reading them.
 *
 * `surface` names the front door for whatever the spawned process records about
 * itself. A bot shells out to the same `jazz run` a terminal user invokes, so
 * without the marker the two are indistinguishable in any per-surface metric.
 */
export function sandboxEnv(
  sandbox: ChatSandbox,
  base: NodeJS.ProcessEnv,
  surface?: string,
  options: ChildEnvOptions = {},
): Record<string, string> {
  const allowed = childEnvironment(base, options);
  const withSurface = surface === undefined ? allowed : { ...allowed, JAZZ_SURFACE: surface };
  // Set whether or not the conversation gets its own uid: which data directory
  // the agent lives in is not an isolation question. A native bridge inherits
  // the operator's environment, where JAZZ_HOME is unset and the run would
  // resolve their own Jazz home instead of the bridge's.
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

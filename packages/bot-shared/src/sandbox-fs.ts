/**
 * @fileoverview Filesystem access into a directory somebody else controls, without following
 * their symlinks.
 *
 * A containerised bridge runs as root and writes into each conversation's Jazz home: its agent
 * file, its config, downloaded media, reminders, run logs. That home is owned by the
 * conversation's uid, which means the agent running there (or a prompt injection steering it)
 * can replace any entry in it with a symlink. A root `writeFile`, `chown` or `unlink` through
 * `home/agents/x.json` then lands wherever the link points: another conversation's home,
 * `/etc`, the bridge's own stores. That is the whole isolation model gone.
 *
 * So everything the bridge does inside a home goes through a directory held open by descriptor
 * (`PinnedDirectory`): the directory is opened `O_NOFOLLOW | O_DIRECTORY`, and every later path
 * is resolved relative to that descriptor via `/proc/self/fd/<fd>/<name>`. Renaming or relinking
 * the directory afterwards changes nothing for us. The last component is guarded separately:
 * reads open with `O_NOFOLLOW`, writes go to a fresh `O_EXCL` temporary file that is renamed
 * over the target (rename replaces a link, it never writes through one), and removals unlink
 * (which never follows).
 *
 * Off Linux there is no `/proc/self/fd`, and there is also no sandbox: a bridge on a Mac runs
 * every conversation as its own user, so there is no privilege for a link to redirect. There
 * the directory's own path is used after the same no-follow checks.
 *
 * Usage:
 *
 *   withDirectory(join(home, "agents"), { create: { owner, mode: 0o2750 } }, (agents) => {
 *     agents.writeText("tg_1.json", json, { owner, mode: 0o640 });
 *   });
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";

/** Who a written file or directory is handed to. Absent keeps whoever wrote it. */
export interface FileOwner {
  readonly uid: number;
  readonly gid: number;
}

/**
 * How everything the bridge writes into one conversation's home is handed over: to whom, and
 * with which modes for directories and files.
 */
export interface Ownership {
  readonly owner: FileOwner;
  readonly directoryMode: number;
  readonly fileMode: number;
}

export interface WriteOptions {
  readonly mode: number;
  readonly owner?: FileOwner | undefined;
}

export interface DirectoryOptions {
  /**
   * Create the directory when missing, and replace anything at its name that is not a real
   * directory (a planted symlink or file). The owner and mode are applied either way, so a
   * directory the bridge relies on is always in the shape it expects.
   */
  readonly create?: WriteOptions;
}

const PERMISSION_BITS = 0o777;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
/** For a root the operator configured, which may legitimately be a link to somewhere else. */
const ROOT_DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

const descriptorPathsAvailable = ((): boolean => {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    return lstatSync("/proc/self/fd").isDirectory();
  } catch {
    return false;
  }
})();

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Apply a mode to an open descriptor, setgid included.
 *
 * Bun's `fchmodSync` and `chmodSync` mask a mode down to the nine permission bits, so a setgid
 * directory silently loses the bit that stamps the operator group onto everything written in
 * it. The coreutils binary applies the mode as given, and pointing it at this process's
 * descriptor path changes the inode that is already open rather than whatever the name
 * resolves to now.
 */
export function setDescriptorMode(descriptor: number, mode: number): void {
  if ((mode & ~PERMISSION_BITS) === 0 || !descriptorPathsAvailable) {
    fchmodSync(descriptor, mode & PERMISSION_BITS);
    return;
  }
  const octal = mode.toString(8).padStart(4, "0");
  const result = Bun.spawnSync(["chmod", octal, `/proc/${process.pid}/fd/${descriptor}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not set mode ${octal}: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

function applyOwnership(descriptor: number, options: WriteOptions): void {
  // chown(2) clears setgid, so the mode goes on afterwards.
  if (options.owner !== undefined) {
    fchownSync(descriptor, options.owner.uid, options.owner.gid);
  }
  setDescriptorMode(descriptor, options.mode);
}

/** One path component: no separators, and never `.` or `..`. */
function assertEntryName(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || /[/\0]/.test(name)) {
    throw new Error(`Refusing unsafe file name ${JSON.stringify(name)}`);
  }
}

function temporaryName(name: string): string {
  return `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

/** A directory held open by descriptor. Close it when done; `withDirectory` does. */
export interface PinnedDirectory {
  /** The path it was opened at, for messages and for handing to a tool as text. */
  readonly path: string;
  /** Where `name` inside this directory resolves, through the descriptor. */
  entry(name: string): string;
  /** Entry names, unfiltered. */
  list(): string[];
  /** A regular file's contents, or undefined when it is absent, a link, or anything else. */
  readText(name: string): string | undefined;
  /** Replace `name` atomically. A link at that name is replaced, never written through. */
  writeBytes(name: string, content: string | Uint8Array, options: WriteOptions): void;
  /**
   * Create `name` as a new file and return a descriptor open for appending. Fails when
   * anything, a link included, is already there. The caller closes the descriptor.
   */
  createAppendOnly(name: string, mode: number): number;
  /** Unlink `name` when present. Never follows. */
  remove(name: string): void;
  /** Last modification of `name` itself (a link's own time, not its target's). */
  modifiedAt(name: string): number | undefined;
  /** Whether nothing at all, not even a dangling link, is at `name`. */
  isAbsent(name: string): boolean;
  /** Create a symlink at `name` pointing at `target`, when nothing is there. */
  link(name: string, target: string): void;
  /** Open a child directory the same way. The caller closes it. */
  directory(name: string, options?: DirectoryOptions): PinnedDirectory;
  close(): void;
}

function openPinned(
  resolvedPath: string,
  displayPath: string,
  options: DirectoryOptions,
  isRoot: boolean,
): PinnedDirectory {
  const created =
    options.create === undefined
      ? false
      : isRoot
        ? createRoot(resolvedPath)
        : prepareDirectory(resolvedPath, displayPath);
  const descriptor = openSync(resolvedPath, isRoot ? ROOT_DIRECTORY_FLAGS : DIRECTORY_FLAGS);
  try {
    if (!fstatSync(descriptor).isDirectory()) {
      throw new Error(`${displayPath} is not a directory`);
    }
    // An owner means the directory's shape is the bridge's to keep, so it is repaired on
    // every open. Without one, only a directory created here gets the mode.
    if (options.create !== undefined && (options.create.owner !== undefined || created)) {
      applyOwnership(descriptor, options.create);
    }
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  return pinnedFromDescriptor(descriptor, resolvedPath, displayPath);
}

/** Create a configured root and its parents. Returns whether it was missing. */
function createRoot(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  mkdirSync(path, { recursive: true });
  return true;
}

/**
 * Make `path` a real directory: anything else at the name (a planted link, a file) is removed
 * first. A link is unlinked, never followed. Returns whether the directory was created.
 */
function prepareDirectory(path: string, displayPath: string): boolean {
  try {
    const existing = lstatSync(path);
    if (existing.isDirectory()) {
      return false;
    }
    console.error(`Replacing ${displayPath}: expected a directory, found something else.`);
    unlinkSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    return false;
  }
}

function pinnedFromDescriptor(
  descriptor: number,
  resolvedPath: string,
  displayPath: string,
): PinnedDirectory {
  const base = descriptorPathsAvailable ? `/proc/self/fd/${descriptor}` : resolvedPath;
  let closed = false;

  const entry = (name: string): string => {
    assertEntryName(name);
    return `${base}/${name}`;
  };

  const openRegular = (name: string, flags: number, mode?: number): number | undefined => {
    let fileDescriptor: number;
    try {
      fileDescriptor =
        mode === undefined ? openSync(entry(name), flags) : openSync(entry(name), flags, mode);
    } catch (error) {
      const code = errorCode(error);
      // ELOOP is a link at the name; the others mean nothing readable is there.
      if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR" || code === "EISDIR") {
        return undefined;
      }
      throw error;
    }
    const stats = fstatSync(fileDescriptor);
    if (!stats.isFile()) {
      closeSync(fileDescriptor);
      return undefined;
    }
    return fileDescriptor;
  };

  return {
    path: displayPath,
    entry,

    list: () => readdirSync(base),

    readText(name: string): string | undefined {
      const fileDescriptor = openRegular(name, READ_FLAGS);
      if (fileDescriptor === undefined) {
        return undefined;
      }
      try {
        return readFileSync(fileDescriptor, "utf8");
      } finally {
        closeSync(fileDescriptor);
      }
    },

    writeBytes(name: string, content: string | Uint8Array, options: WriteOptions): void {
      assertEntryName(name);
      const temporary = temporaryName(name);
      const fileDescriptor = openSync(
        entry(temporary),
        CREATE_FLAGS,
        options.mode & PERMISSION_BITS,
      );
      try {
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        let written = 0;
        while (written < bytes.length) {
          written += writeSync(fileDescriptor, bytes, written, bytes.length - written);
        }
        applyOwnership(fileDescriptor, options);
      } catch (error) {
        closeSync(fileDescriptor);
        unlinkSync(entry(temporary));
        throw error;
      }
      closeSync(fileDescriptor);
      try {
        renameSync(entry(temporary), entry(name));
      } catch (error) {
        unlinkSync(entry(temporary));
        throw error;
      }
    },

    createAppendOnly(name: string, mode: number): number {
      return openSync(entry(name), CREATE_FLAGS | constants.O_APPEND, mode & PERMISSION_BITS);
    },

    remove(name: string): void {
      try {
        unlinkSync(entry(name));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      }
    },

    modifiedAt(name: string): number | undefined {
      try {
        return lstatSync(entry(name)).mtimeMs;
      } catch {
        return undefined;
      }
    },

    isAbsent(name: string): boolean {
      try {
        lstatSync(entry(name));
        return false;
      } catch {
        return true;
      }
    },

    link(name: string, target: string): void {
      symlinkSync(target, entry(name));
    },

    directory(name: string, options: DirectoryOptions = {}): PinnedDirectory {
      return openPinned(entry(name), `${displayPath}/${name}`, options, false);
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      closeSync(descriptor);
    },
  };
}

/**
 * Open `path` as a pinned directory: the root everything else is opened from.
 *
 * `path` itself is followed, since it is a location the operator configured (a data
 * directory, or a conversation home whose parent only root can write). Every name opened
 * from it with `directory()` is not. Throws when the directory is missing and `create` is not
 * set.
 */
export function openDirectory(path: string, options: DirectoryOptions = {}): PinnedDirectory {
  return openPinned(path, path, options, true);
}

/** Run `operation` against a pinned directory and close it afterwards. */
export function withDirectory<T>(
  path: string,
  options: DirectoryOptions,
  operation: (directory: PinnedDirectory) => T,
): T {
  const directory = openDirectory(path, options);
  try {
    return operation(directory);
  } finally {
    directory.close();
  }
}

/**
 * Open the directory holding `path` along a chain of names below `root`, creating each level
 * with `create` when given.
 *
 * For a file two levels into a home (`home/logs/runs/x.ndjson`), where each level is a name
 * the conversation controls and must be pinned in turn.
 */
export function openNestedDirectory(
  root: string,
  names: readonly string[],
  options: DirectoryOptions = {},
): PinnedDirectory {
  let current = openDirectory(root);
  for (const name of names) {
    try {
      const next = current.directory(name, options);
      current.close();
      current = next;
    } catch (error) {
      current.close();
      throw error;
    }
  }
  return current;
}

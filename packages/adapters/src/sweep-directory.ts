/**
 * Descriptor-relative filesystem operations for unattended cleanup on macOS and Linux.
 * Load this module only when a sweep runs. Open every directory component without following
 * links, enumerate through an owned DIR stream, and unlink relative to the opened parent.
 * Node handles descriptor metadata and timestamps; libc supplies relative opens, unlinking and enumeration.
 * No path-based deletion fallback is provided when native loading fails.
 */
import { constants, closeSync, fstatSync, futimesSync, type Stats } from "node:fs";
import { constants as osConstants } from "node:os";
import * as path from "node:path";
import { dlopen, toArrayBuffer } from "bun:ffi";

const darwin = process.platform === "darwin";
if (!darwin && process.platform !== "linux") {
  throw new Error("Cleanup requires macOS or Linux");
}
if (process.arch !== "arm64" && process.arch !== "x64") {
  throw new Error("Unsupported cleanup ABI");
}
const readdirSymbol = darwin && process.arch === "x64" ? "readdir$INODE64" : "readdir";
const native = dlopen(darwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  openat: { args: ["i32", "buffer", "i32"], returns: "i32" },
  mkdirat: { args: ["i32", "buffer", "u32"], returns: "i32" },
  unlinkat: { args: ["i32", "buffer", "i32"], returns: "i32" },
  fdopendir: { args: ["i32"], returns: "ptr" },
  [readdirSymbol]: { args: ["ptr"], returns: "ptr" },
  closedir: { args: ["ptr"], returns: "i32" },
  [darwin ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
} as const);
const errnoPointer = native.symbols[darwin ? "__error" : "__errno_location"]!();
if (errnoPointer === null) {
  throw new Error("Cannot access native errno");
}
const errno = new DataView(toArrayBuffer(errnoPointer, 0, 4));
const closeOnExec = darwin ? 0x01000000 : 0x80000;
const directoryFlags =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
// O_EVTONLY|O_SYMLINK on Darwin and O_PATH on Linux inspect even links and FIFOs without reading them.
const entryDecoder = new TextDecoder("utf-8", { fatal: true });
const metadataFlags =
  (darwin ? 0x00008000 | 0x00200000 : 0x200000 | constants.O_NOFOLLOW) | closeOnExec;

function nativeError(operation: string): NodeJS.ErrnoException {
  const number = errno.getInt32(0, true);
  const code = Object.entries(osConstants.errno).find(([, value]) => value === number)?.[0];
  return Object.assign(new Error(`${operation} failed (${code ?? number})`), {
    ...(code === undefined ? {} : { code }),
    errno: number,
  });
}

function segment(name: string): Buffer {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new Error("Invalid cleanup path component");
  }
  return Buffer.from(`${name}\0`);
}

/** An owned directory handle. Call close in finally; child handles have independent ownership. */
export class SweepDirectory {
  private closed = false;
  private constructor(private readonly fd: number) {}

  /** Opens an absolute root without following a link in any component, including the root. */
  static open(this: void, root: string): SweepDirectory {
    const resolved = path.resolve(root);
    const fd = native.symbols.openat(darwin ? -2 : -100, Buffer.from("/\0"), directoryFlags);
    if (fd < 0) {
      throw nativeError("open root");
    }
    let directory = new SweepDirectory(fd);
    try {
      for (const name of resolved.split("/").filter(Boolean)) {
        const child = directory.child(name, true);
        directory.close();
        directory = child;
      }
      return directory;
    } catch (error) {
      directory.close();
      throw error;
    }
  }

  child(name: string, allowMount = false): SweepDirectory {
    const fd = native.symbols.openat(this.fd, segment(name), directoryFlags);
    if (fd < 0) {
      throw nativeError("open directory");
    }
    const child = new SweepDirectory(fd);
    try {
      if (!allowMount && fstatSync(fd).dev !== fstatSync(this.fd).dev) {
        throw new Error("Cleanup does not cross mounted filesystems");
      }
      return child;
    } catch (error) {
      child.close();
      throw error;
    }
  }

  stat(name: string): Stats {
    const fd = native.symbols.openat(this.fd, segment(name), metadataFlags);
    if (fd < 0) {
      throw nativeError("inspect entry");
    }
    try {
      return fstatSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** Reads one entry at a time; breaking the iterator closes its descriptor immediately. */
  *entries(): Generator<string> {
    const fd = native.symbols.openat(this.fd, Buffer.from(".\0"), directoryFlags);
    if (fd < 0) {
      throw nativeError("open directory stream");
    }
    const stream = native.symbols.fdopendir(fd);
    if (stream === null) {
      const error = nativeError("fdopendir");
      closeSync(fd);
      throw error;
    }
    try {
      while (true) {
        errno.setInt32(0, 0, true);
        const entry = native.symbols[readdirSymbol]!(stream);
        if (entry === null) {
          if (errno.getInt32(0, true) !== 0) {
            throw nativeError("readdir");
          }
          break;
        }
        const recordLength = new DataView(toArrayBuffer(entry, 0, 18)).getUint16(16, true);
        const offset = darwin ? 21 : 19;
        if (recordLength <= offset) {
          throw new Error("Invalid directory entry length");
        }
        const bytes = new Uint8Array(toArrayBuffer(entry, offset, recordLength - offset));
        const terminator = bytes.indexOf(0);
        if (terminator < 0) {
          throw new Error("Unterminated directory entry");
        }
        const name = entryDecoder.decode(bytes.subarray(0, terminator));
        if (name !== "." && name !== "..") {
          yield name;
        }
      }
    } finally {
      native.symbols.closedir(stream);
    }
  }

  remove(name: string, directory = false): void {
    if (
      native.symbols.unlinkat(this.fd, segment(name), directory ? (darwin ? 0x80 : 0x200) : 0) !== 0
    ) {
      throw nativeError("unlinkat");
    }
  }

  /** Replaces the stamp inode so neither symlinks nor hardlinks can redirect timestamp writes. */
  stamp(name: string, now: number): void {
    try {
      this.remove(name);
    } catch (error) {
      if (!isMissingSweepPath(error)) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error.code === "EISDIR" || error.code === "EPERM")
        ) {
          this.remove(name, true);
        } else {
          throw error;
        }
      }
    }
    if (native.symbols.mkdirat(this.fd, segment(name), 0o700) !== 0) {
      throw nativeError("create sweep stamp");
    }
    const stamp = this.child(name);
    try {
      futimesSync(stamp.fd, now / 1000, now / 1000);
    } finally {
      stamp.close();
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      closeSync(this.fd);
    }
  }
}

export function isMissingSweepPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

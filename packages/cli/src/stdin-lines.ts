/**
 * Line-at-a-time reader over a readable stream, used by the plain terminal to
 * answer text prompts from piped stdin (`echo hello | jazz agent chat x`).
 *
 * `next()` resolves with the next line, or `undefined` once the stream has
 * ended. It never resolves early with an invented value: a caller looping on
 * `next()` either waits for real input or learns the input is over.
 *
 * The stream is only read while someone is waiting for a line, so an idle
 * reader does not keep the process alive or swallow input meant for a later
 * consumer. Lines that arrive in the same chunk are queued for the next calls.
 */

import { createInterface, type Interface } from "node:readline";

export interface LineSource {
  /** The next line without its terminator, or `undefined` at end of input. */
  readonly next: () => Promise<string | undefined>;
  /** Stop reading and release the stream. Pending and later `next()` calls resolve `undefined`. */
  readonly close: () => void;
}

export function createLineSource(input: NodeJS.ReadableStream): LineSource {
  const queuedLines: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let reader: Interface | undefined;
  let ended = false;

  const finish = (): void => {
    ended = true;
    for (const waiter of waiters.splice(0)) {
      waiter(undefined);
    }
  };

  const ensureReader = (): Interface => {
    if (reader !== undefined) {
      return reader;
    }
    const created = createInterface({ input, crlfDelay: Infinity, terminal: false });
    created.on("line", (line) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(line);
      } else {
        queuedLines.push(line);
      }
      if (waiters.length === 0) {
        created.pause();
      }
    });
    created.on("close", finish);
    reader = created;
    return created;
  };

  return {
    next: () => {
      const queued = queuedLines.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (ended) {
        return Promise.resolve(undefined);
      }
      return new Promise<string | undefined>((resolve) => {
        waiters.push(resolve);
        ensureReader().resume();
      });
    },
    close: () => {
      if (reader !== undefined) {
        reader.close();
      }
      finish();
    },
  };
}

/**
 * @fileoverview Serving and sending what `create_composition` made, without trusting the paths
 * a run reports.
 *
 * A run's envelope names the web app it made (`sessionId`, `filename`, `htmlPath`,
 * `imagePath`). That envelope is the agent's output, so a prompt-injected or tampered run can
 * name any file: the bridge, running as root, would then upload `/data/chats/<someone
 * else>/...` as a "chart", or serve it from its web server. And the old public URL was
 * `/compositions/<conversation key>/<title>.html`, both guessable, read from whichever home
 * had a match.
 *
 * So:
 *  - a file a composition names is only ever read from the owning conversation's own
 *    `compositions/<session>/` directory, through pinned directories that never follow a link,
 *    and only when its names are plain path segments;
 *  - an interactive app is published under an opaque random id, recorded in a store the
 *    bridge owns, so a URL resolves to exactly one conversation's file and cannot be guessed.
 */

import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { chatHome } from "./chat-sandbox";
import type { JazzComposition } from "./jazz-run";
import { openDirectory } from "./sandbox-fs";
import { readRecordStore, recordStorePath, writeRecordStore } from "./scoped-record-store";

const COMPOSITIONS_DIRECTORY = "compositions";
const SESSION_PATTERN = /^[A-Za-z0-9_-]+$/;
const FILE_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:html|png)$/;
const LINK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How many published apps stay reachable. Each one is a link somebody was sent in a chat;
 * past this the oldest stop resolving, which bounds a store nothing else prunes.
 */
const PUBLISHED_LINK_LIMIT = 1_000;

/** Where a published app lives: which conversation, and the file inside its compositions. */
interface PublishedComposition {
  readonly agentId: string;
  readonly sessionId: string;
  readonly filename: string;
}

/**
 * Read a file inside a conversation's `compositions/<sessionId>/`, never through a link.
 * Undefined for a name that is not a plain segment, or a file that is not there.
 */
export function readCompositionFile(
  home: string,
  sessionId: string,
  filename: string,
): Uint8Array<ArrayBuffer> | undefined {
  if (!SESSION_PATTERN.test(sessionId) || !FILE_PATTERN.test(filename)) {
    return undefined;
  }
  try {
    const root = openDirectory(home);
    try {
      const compositions = root.directory(COMPOSITIONS_DIRECTORY);
      try {
        const session = compositions.directory(sessionId);
        try {
          const bytes = session.readBytes(filename);
          return bytes === undefined ? undefined : new Uint8Array(bytes);
        } finally {
          session.close();
        }
      } finally {
        compositions.close();
      }
    } finally {
      root.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * The static image a composition names, read from the owning home.
 *
 * The envelope's `imagePath` is accepted only when it is exactly
 * `<home>/compositions/<sessionId>/<plain name>.png`.
 */
export function readCompositionImage(
  home: string,
  composition: JazzComposition,
): { readonly bytes: Uint8Array<ArrayBuffer>; readonly filename: string } | undefined {
  const imagePath = compositionImagePath(home, composition);
  if (imagePath === undefined) {
    return undefined;
  }
  const filename = basename(imagePath);
  const bytes = readCompositionFile(home, composition.sessionId, filename);
  return bytes === undefined ? undefined : { bytes, filename };
}

/**
 * The composition's `imagePath` when it is exactly `<home>/compositions/<sessionId>/<plain
 * name>.png`, and undefined for anything else the envelope might claim.
 */
export function compositionImagePath(
  home: string,
  composition: JazzComposition,
): string | undefined {
  const imagePath = composition.imagePath;
  if (imagePath === undefined || !SESSION_PATTERN.test(composition.sessionId)) {
    return undefined;
  }
  const filename = basename(imagePath);
  const expectedDirectory = join(home, COMPOSITIONS_DIRECTORY, composition.sessionId);
  if (dirname(imagePath) !== expectedDirectory || !FILE_PATTERN.test(filename)) {
    return undefined;
  }
  return join(expectedDirectory, filename);
}

export interface CompositionLinks {
  /**
   * Record an interactive app for serving and return the opaque id its URL carries, or
   * undefined when its names are not plain path segments.
   */
  publish(agentId: string, composition: JazzComposition): string | undefined;
  /** The page for a published id, read from the owning conversation's home. */
  page(id: string): Uint8Array<ArrayBuffer> | undefined;
}

/**
 * The published apps of one bridge, kept in `<dataDir>/<storeFile>` so a link keeps working
 * across a restart.
 */
export function createCompositionLinks(dataDir: string, storeFile: string): CompositionLinks {
  const storePath = recordStorePath(dataDir, storeFile);

  return {
    publish(agentId: string, composition: JazzComposition): string | undefined {
      if (
        !SESSION_PATTERN.test(composition.sessionId) ||
        !FILE_PATTERN.test(composition.filename)
      ) {
        return undefined;
      }
      const id = randomUUID();
      const current = readRecordStore<PublishedComposition>(storePath) ?? {};
      const entries = Object.entries(current).slice(-(PUBLISHED_LINK_LIMIT - 1));
      writeRecordStore(storePath, {
        ...Object.fromEntries(entries),
        [id]: { agentId, sessionId: composition.sessionId, filename: composition.filename },
      });
      return id;
    },

    page(id: string): Uint8Array<ArrayBuffer> | undefined {
      if (!LINK_ID_PATTERN.test(id)) {
        return undefined;
      }
      const published = readRecordStore<PublishedComposition>(storePath)?.[id];
      if (published === undefined) {
        return undefined;
      }
      return readCompositionFile(
        chatHome(dataDir, published.agentId),
        published.sessionId,
        published.filename,
      );
    },
  };
}

/** The path a published app is served at: `/compositions/<id>`. */
export function compositionLinkPath(id: string): string {
  return `/${COMPOSITIONS_DIRECTORY}/${id}`;
}

/** The id in a request path, when it is a composition route at all. */
export function compositionIdFromPath(pathname: string): string | undefined {
  const match = /^\/compositions\/([0-9a-f-]{36})$/.exec(pathname);
  return match?.[1];
}

import { useEffect, useMemo, useState } from "react";
import { atMentionSpan, type AtMentionSpan } from "./at-mention";
import { scanFilePickerEntries } from "./file-picker-files";

/**
 * How long a keystroke settles before the `@` menu walks the filesystem. Long
 * enough that typing a path does not launch a scan per character, short enough
 * that pausing feels like the menu was already there.
 */
export const MENTION_SCAN_DEBOUNCE_MS = 90;

/** Candidates fetched for the `@` menu; it only ever shows a handful. */
export const MENTION_MAX_RESULTS = 40;

/** One suggested path, shaped like the entries the command menu renders. */
export interface FileMentionItem {
  readonly name: string;
  readonly description: string;
}

export interface FileMentions {
  /** The span being completed, or null when the caret is not in a mention. */
  readonly span: AtMentionSpan | null;
  /** Paths matching the span, empty while scanning or when nothing matches. */
  readonly items: readonly FileMentionItem[];
}

/**
 * Suggest local paths for the `@` mention under the caret.
 *
 * Shared by both composers — the fullscreen one and the Ink fallback — so the
 * debounce, the scan bounds, and the "what counts as a mention" rule cannot
 * drift between them.
 */
export function useFileMentions(text: string, caret: number): FileMentions {
  const span = useMemo(() => atMentionSpan(text, caret), [text, caret]);
  const query = span?.query;
  const [items, setItems] = useState<readonly FileMentionItem[]>([]);

  useEffect(() => {
    if (query === undefined) {
      setItems([]);
      return;
    }

    let cancelled = false;
    // A keystroke lands faster than a directory walk finishes, so the scan is
    // held back briefly and any in-flight result is discarded on the next one.
    const timer = setTimeout(() => {
      void scanFilePickerEntries({
        basePath: process.cwd(),
        query,
        includeDirectories: true,
        maxResults: MENTION_MAX_RESULTS,
      })
        .then((entries) => {
          if (cancelled) return;
          setItems(
            entries.map((entry) => ({
              name: entry.name,
              description: entry.isDirectory ? "directory" : "",
            })),
          );
        })
        .catch(() => {
          // An unreadable directory is not worth surfacing mid-keystroke; the
          // menu simply stays empty.
          if (!cancelled) setItems([]);
        });
    }, MENTION_SCAN_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return { span, items };
}

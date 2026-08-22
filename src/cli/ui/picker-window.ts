export const PICKER_WINDOW_SIZE = 10;

export interface PickerFilterable {
  readonly label: string;
  readonly value?: unknown;
  readonly description?: string;
}

export interface RankedPickerMatch<T> {
  readonly item: T;
  readonly matchIndex: number;
}

export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function carouselWindow<Item>(
  items: readonly Item[],
  selected: number,
  size: number,
): readonly Item[] {
  if (items.length === 0) return [];
  if (items.length <= size) return items;
  const start = wrapIndex(selected - size + 1, items.length);
  return Array.from(
    { length: size },
    (_, offset) => items[wrapIndex(start + offset, items.length)] as Item,
  );
}

export function pickerWindowStart(selected: number, length: number, size: number): number {
  if (length <= 0 || size <= 0 || length <= size) return 0;
  return Math.max(0, Math.min(selected - size + 1, length - size));
}

export function pickerWindow<Item>(
  items: readonly Item[],
  selected: number,
  size: number,
): readonly Item[] {
  const start = pickerWindowStart(selected, items.length, size);
  return items.slice(start, start + Math.max(0, size));
}

export function pickerItemMatches(item: PickerFilterable, query: string): boolean {
  const lowerQuery = query.trim().toLowerCase();
  if (lowerQuery.length === 0) return true;
  const identity = typeof item.value === "string" ? item.value : "";
  return [item.label, identity, item.description ?? ""].some((text) =>
    text.toLowerCase().includes(lowerQuery),
  );
}

export function rankPickerMatches<T extends PickerFilterable>(
  items: readonly T[],
  query: string,
): readonly RankedPickerMatch<T>[] {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) {
    return items.map((item) => ({ item, matchIndex: -1 }));
  }

  const WORD_BOUNDARY = new Set([" ", "-", "_", "/", ".", "("]);
  const scored: { item: T; matchIndex: number; rank: number }[] = [];
  for (const item of items) {
    if (!pickerItemMatches(item, query)) continue;
    const matchIndex = item.label.toLowerCase().indexOf(lowerQuery);
    const rank =
      matchIndex === 0
        ? 0
        : matchIndex > 0 && WORD_BOUNDARY.has(item.label[matchIndex - 1] ?? "")
          ? 1
          : matchIndex >= 0
            ? 2
            : 3;
    scored.push({ item, matchIndex, rank });
  }
  scored.sort((left, right) => left.rank - right.rank || left.matchIndex - right.matchIndex);
  return scored.map(({ item, matchIndex }) => ({ item, matchIndex }));
}

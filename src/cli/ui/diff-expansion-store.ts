export interface DiffExpansionPayload {
  readonly fullDiff: string;
  readonly timestamp: number;
}

let lastDiff: DiffExpansionPayload | null = null;

export function setLastExpandedDiff(fullDiff: string): void {
  lastDiff = { fullDiff, timestamp: Date.now() };
}

export function getLastExpandedDiff(): DiffExpansionPayload | null {
  return lastDiff;
}

export function clearLastExpandedDiff(): void {
  lastDiff = null;
}

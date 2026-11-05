/**
 * Read a state-file body as the record type its file kind stores. The state-file boundary checks
 * only that the body is an object; per-field shape is the writer's contract, since every file is
 * written by `serialize` of the same kind. Used by the kinds whose records are stored verbatim.
 */
export function asStoredRecord<Stored extends object>(body: Record<string, unknown>): Stored {
  return body as Stored;
}

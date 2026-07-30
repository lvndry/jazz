/** Maximum nesting depth (path segments) allowed under an agent's memory root. */
export const MAX_MEMORY_PATH_DEPTH = 4;

/** Maximum length of a single path segment (file or directory name). */
export const MAX_MEMORY_PATH_SEGMENT_LENGTH = 128;

/** Maximum size of a single memory file, in bytes. */
export const MAX_MEMORY_FILE_BYTES = 262_144;

/** Maximum total size of an agent's entire memory directory, in bytes. */
export const MAX_MEMORY_TOTAL_BYTES_PER_AGENT = 10_485_760;

/** Maximum number of files an agent's memory directory may contain. */
export const MAX_MEMORY_FILES_PER_AGENT = 500;

/** Character budget for a single `view` call before content is truncated. */
export const MEMORY_VIEW_TRUNCATE_CHARS = 20_000;

/** Reject `view` on files with more lines than this. */
export const MEMORY_VIEW_MAX_LINES = 999_999;

/** Maximum nesting depth (path segments) allowed under an agent's workspace root. */
export const MAX_WORKSPACE_PATH_DEPTH = 6;

/** Maximum length of a single path segment (file or directory name). */
export const MAX_WORKSPACE_PATH_SEGMENT_LENGTH = 128;

/** Maximum size of a single workspace file, in bytes. */
export const MAX_WORKSPACE_FILE_BYTES = 5_242_880;

/**
 * Default total size of an agent's entire workspace directory, in bytes, used
 * when `workspaceMaxTotalBytesPerAgent` is not set in config. User-configurable
 * because scratch-space needs vary far more than memory's curated-notes budget.
 */
export const DEFAULT_MAX_WORKSPACE_TOTAL_BYTES_PER_AGENT = 1_073_741_824;

/** Maximum number of files an agent's workspace directory may contain. */
export const MAX_WORKSPACE_FILES_PER_AGENT = 2_000;

/** Character budget for a single `view` call before content is truncated. */
export const WORKSPACE_VIEW_TRUNCATE_CHARS = 20_000;

/** Reject `view` on files with more lines than this. */
export const WORKSPACE_VIEW_MAX_LINES = 999_999;

/** Maximum nesting depth (path segments) allowed under a memory scope's root. */
export const MAX_MEMORY_PATH_DEPTH = 4;

/** Maximum length of a single path segment (file or directory name). */
export const MAX_MEMORY_PATH_SEGMENT_LENGTH = 128;

/** Maximum size of a single memory file, in bytes. */
export const MAX_MEMORY_FILE_BYTES = 262_144;

/** Maximum total size of one memory scope's entire directory, in bytes. */
export const MAX_MEMORY_TOTAL_BYTES_PER_SCOPE = 10_485_760;

/** Maximum number of files one memory scope's directory may contain. */
export const MAX_MEMORY_FILES_PER_SCOPE = 500;

/** Character budget for a single `view` call before content is truncated. */
export const MEMORY_VIEW_TRUNCATE_CHARS = 20_000;

/** Reject `view` on files with more lines than this. */
export const MEMORY_VIEW_MAX_LINES = 999_999;

/**
 * Scope every agent writes to when none is configured.
 *
 * Memory belongs to the person, not to whichever agent happens to run. A
 * preference like "concise replies" should follow the user across agents, so
 * the default is one shared scope rather than one silo per agent id.
 */
export const DEFAULT_MEMORY_SCOPE = "personal";

/**
 * Agent id the compaction-time extraction pass runs under.
 *
 * Shared so a write can be attributed: an entry written under this id was
 * inferred by an unattended pass, while any other id means the agent wrote it
 * while a person was in the conversation.
 */
export const MEMORY_EXTRACTOR_AGENT_ID = "memory-extractor";

/**
 * Longest derived entry summary kept in the sidecar. Entries are one thought
 * each, so anything past this is prose that belongs in the body rather than in
 * the text the recall index ranks on.
 */
export const MEMORY_SUMMARY_MAX_CHARS = 200;

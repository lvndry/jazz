/**
 * The permission bits Jazz gives everything it writes under `$JAZZ_HOME`: conversations,
 * memory, logs and state are readable by their owner only, so another account on a shared
 * machine cannot read them.
 */

/** Owner read and write. */
export const PRIVATE_FILE_MODE = 0o600;

/** Owner read, write and traverse. */
export const PRIVATE_DIRECTORY_MODE = 0o700;

/** Group and other bits; clearing them makes a mode private without touching the owner's. */
export const NON_OWNER_PERMISSION_BITS = 0o077;

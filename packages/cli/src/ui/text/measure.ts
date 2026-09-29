/**
 * Running prose stops at this many cells however wide the window is, so the
 * eye always returns to the same left edge. Tables and code are scanned rather
 * than read, and may take the full width. Every renderer sets prose to it.
 */
export const PROSE_MEASURE = 88;

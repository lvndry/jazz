/**
 * Small on purpose — a self-scheduled wake-up causes a real unattended run, unlike a
 * reminder (which just delivers text to a human). A model that talks itself into
 * rescheduling repeatedly should hit this ceiling long before it burns meaningful spend.
 */
export const MAX_WAKE_TRIGGERS_PER_AGENT = 20;

/** Maximum length, in characters, of a wake trigger's prompt. */
export const WAKE_TRIGGER_PROMPT_MAX_LENGTH = 2000;

/** Maximum length, in characters, of a wake trigger's reason (shown to the human, not the model). */
export const WAKE_TRIGGER_REASON_MAX_LENGTH = 300;

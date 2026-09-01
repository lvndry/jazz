/**
 * Shared request dispatcher for the Telegram Bot API.
 *
 * Both JSON calls (`callTelegram`) and multipart photo uploads (`sendPhotoFile`) in
 * `bridge.ts` funnel every outgoing request through `dispatchTelegramRequest` so they get
 * the same flood-control handling: a confirmed 429 (an HTTP response, not a network
 * failure) is retried using the server's `retry_after`, up to `RATE_LIMIT_MAX_ATTEMPTS`
 * attempts and `RATE_LIMIT_MAX_TOTAL_WAIT_MS` of cumulative wait, and the cooldown is
 * remembered across every chat so the next call anywhere waits it out too — Telegram's
 * rate limit is bot-wide, not per-request. A network failure (the `fetch` call itself
 * throwing) is never retried: the request's outcome at Telegram is unknown, and retrying
 * could send a duplicate message. `bestEffort` requests (live progress edits, typing
 * indicators) are dropped rather than retried or waited on, since a stale status is worse
 * than a missing one. Requests for the same chat are queued so they land in the order
 * they were issued, even when one of them is mid-retry.
 */

const RATE_LIMIT_MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_TOTAL_WAIT_MS = 60_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 1_000;

let botCooldownUntil = 0;
const chatQueues = new Map<number, Promise<void>>();

export interface TelegramDispatchRequest {
  readonly method: string;
  readonly chatId?: number | undefined;
  readonly bestEffort?: boolean;
  readonly send: () => Promise<Response>;
}

interface TelegramErrorBody {
  readonly ok?: boolean;
  readonly error_code?: number;
  readonly parameters?: { readonly retry_after?: unknown };
}

/** Telegram's own body says whether the request was received and rejected, not lost. */
export function isRenderingRejection(response: unknown): boolean {
  if (typeof response !== "object" || response === null) return false;
  const body = response as TelegramErrorBody;
  return body.ok === false && body.error_code !== 429;
}

function retryAfterMsFrom(body: unknown): number {
  const seconds = (body as TelegramErrorBody | undefined)?.parameters?.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : DEFAULT_RATE_LIMIT_WAIT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attempt(request: TelegramDispatchRequest): Promise<unknown> {
  let totalWaitedMs = 0;
  for (let attemptNumber = 1; attemptNumber <= RATE_LIMIT_MAX_ATTEMPTS; attemptNumber++) {
    const cooldownMs = botCooldownUntil - Date.now();
    if (cooldownMs > 0) {
      if (request.bestEffort) return undefined;
      await sleep(cooldownMs);
    }

    let response: Response;
    try {
      response = await request.send();
    } catch (error) {
      console.error(`Telegram ${request.method} request failed: ${String(error)}`);
      return undefined;
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok && (body as TelegramErrorBody | undefined)?.ok === true) {
      return body;
    }

    if (response.status === 429) {
      const waitMs = retryAfterMsFrom(body);
      botCooldownUntil = Math.max(botCooldownUntil, Date.now() + waitMs);
      const isLastAttempt = attemptNumber === RATE_LIMIT_MAX_ATTEMPTS;
      const exceedsBudget = totalWaitedMs + waitMs > RATE_LIMIT_MAX_TOTAL_WAIT_MS;
      if (request.bestEffort || isLastAttempt || exceedsBudget) {
        console.error(
          `Telegram ${request.method} rate-limited; giving up after ${String(attemptNumber)} attempt(s)`,
        );
        return body;
      }
      totalWaitedMs += waitMs;
      await sleep(waitMs);
      continue;
    }

    console.error(
      `Telegram ${request.method} failed: ${String(response.status)} ${JSON.stringify(body)}`,
    );
    return body;
  }
  return undefined;
}

/** Runs `request`, after any earlier request queued for the same chat has settled. */
export function dispatchTelegramRequest(request: TelegramDispatchRequest): Promise<unknown> {
  if (request.chatId === undefined) return attempt(request);

  const chatId = request.chatId;
  const previous = chatQueues.get(chatId) ?? Promise.resolve();
  const settled = previous.then(() => attempt(request));
  const marker = settled.then(
    () => undefined,
    () => undefined,
  );
  chatQueues.set(chatId, marker);
  void marker.finally(() => {
    if (chatQueues.get(chatId) === marker) chatQueues.delete(chatId);
  });
  return settled;
}

/** Test-only: clears cooldown and queue state carried between test cases. */
export function resetTelegramDispatchState(): void {
  botCooldownUntil = 0;
  chatQueues.clear();
}

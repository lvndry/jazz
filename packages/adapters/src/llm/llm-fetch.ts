/**
 * The `fetch` every LLM provider is built with.
 *
 * Bun aborts a `fetch` that has not finished after 300 seconds unless it passes
 * `timeout: false`. A queued hosted model (NVIDIA NIM often takes over three minutes to its
 * first token) or a local model prefilling a long prompt runs past that, and the request died
 * with `TimeoutError` regardless of `llm.streamIdleTimeoutMs`. Jazz bounds each call itself:
 * the stream idle timeout while streaming, and `LLM_TIMEOUT_SECONDS`, whose interruption
 * aborts the request through its signal.
 */
export const llmFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetch(input, { ...init, timeout: false }),
  { preconnect: fetch.preconnect },
);

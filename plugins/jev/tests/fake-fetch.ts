/** A `fetch` double: the handler answers every request, and `preconnect` is the runtime's no-op. */
export function fakeFetch(
  respond: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(respond, { preconnect: () => {} });
}

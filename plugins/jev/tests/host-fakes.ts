/** A `fetch` double: the handler answers every request, and `preconnect` is the runtime's no-op. */
export function fakeFetch(
  respond: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(respond, { preconnect: () => {} });
}

/**
 * Handlers a plugin registered, keyed by hook id and typed per id. `get` narrows the stored value
 * to that id's handler type, which is sound because the only writer is the host API's
 * `register(id, handler)`, whose signature already ties each handler to its own id.
 */
export class HookRegistry<HandlerById extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof HandlerById, unknown>();

  set(id: keyof HandlerById, handler: unknown): void {
    this.handlers.set(id, handler);
  }

  get<Id extends keyof HandlerById>(id: Id): HandlerById[Id] | undefined {
    return this.handlers.get(id) as HandlerById[Id] | undefined;
  }

  has(id: keyof HandlerById): boolean {
    return this.handlers.has(id);
  }
}

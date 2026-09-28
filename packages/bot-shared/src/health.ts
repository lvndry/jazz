/**
 * @fileoverview Whether a bridge is actually working, for a health check to ask.
 *
 * A health endpoint that always answers "ok" reports a revoked token, a poll loop stuck on a
 * 409 conflict, or a gateway reconnecting forever as healthy, and the container supervisor
 * and the auto-update rollback both trust it. So a bridge reports each success of the thing
 * it depends on (a poll, a heartbeat acknowledgement, an open connection), and it is healthy
 * only while the last one is recent.
 */

export interface HealthStatus {
  readonly healthy: boolean;
  readonly detail: string;
}

export interface HealthState {
  /** The transport just worked. */
  beat(): void;
  /** The transport cannot work until someone intervenes (a revoked token, say). */
  fail(reason: string): void;
  status(): HealthStatus;
}

/**
 * Healthy while the last `beat()` is under `staleAfterMs` old and nothing called `fail`.
 * Starts healthy for `startupGraceMs`, so a slow first connection is not reported as down.
 */
export function createHealthState(
  staleAfterMs: number,
  startupGraceMs: number = staleAfterMs,
  now: () => number = Date.now,
): HealthState {
  let lastBeat: number | undefined;
  let failure: string | undefined;
  const startedAt = now();
  return {
    beat() {
      lastBeat = now();
    },
    fail(reason) {
      failure = reason;
    },
    status() {
      if (failure !== undefined) return { healthy: false, detail: failure };
      if (lastBeat === undefined) {
        const waiting = now() - startedAt;
        return waiting < startupGraceMs
          ? { healthy: true, detail: "starting" }
          : { healthy: false, detail: `no successful contact in ${Math.round(waiting / 1000)}s` };
      }
      const ageMs = now() - lastBeat;
      return ageMs <= staleAfterMs
        ? { healthy: true, detail: `last contact ${Math.round(ageMs / 1000)}s ago` }
        : { healthy: false, detail: `last contact ${Math.round(ageMs / 1000)}s ago` };
    },
  };
}

/** `/health`'s answer: 200 with the detail when healthy, 503 when not. */
export function healthResponse(health: HealthState): Response {
  const status = health.status();
  return new Response(`${status.healthy ? "ok" : "unhealthy"}: ${status.detail}\n`, {
    status: status.healthy ? 200 : 503,
  });
}

/**
 * A server with only `/health`, for a bridge that has no HTTP server of its own. Started
 * only when a port is configured (`JAZZ_BRIDGE_HEALTH_PORT`). Returns a function that stops it.
 */
export function startHealthOnlyServer(port: number, health: HealthState): () => void {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(request) {
      return new URL(request.url).pathname === "/health"
        ? healthResponse(health)
        : new Response("not found", { status: 404 });
    },
  });
  console.error(`Health check on http://127.0.0.1:${port}/health`);
  return () => {
    void server.stop(true);
  };
}

/**
 * The HTTP API (#212, docs/API.md): a Hono app under `/v1`, served on 127.0.0.1 only (decision 0008).
 * Routes are added by their own modules through `routes`; this file owns the prefix, the error format and the
 * listener.
 */
import type { ErrorCode, ErrorResponse } from "@vigil/api-types";
import { ERROR_STATUS } from "@vigil/api-types";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The interface the API listens on. The local release is not reachable from outside (decision 0008). */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;
/** Every interface of the container; only for the Docker image, whose port compose binds to 127.0.0.1 on the host. */
export const CONTAINER_HOST = "0.0.0.0";

/**
 * The interface to listen on: `127.0.0.1` unless `VIGIL_HOST` is `0.0.0.0`. The Docker image (#260) sets that, because
 * a server on the container's 127.0.0.1 cannot be reached through a published port; `docker-compose.yml` (#262)
 * publishes it as `127.0.0.1:8787:8787`, so the host still keeps it to itself. No other value is accepted.
 */
export function listenHost(env: Record<string, string | undefined> = process.env): string {
  const host = env.VIGIL_HOST;
  if (host === undefined || host === "" || host === HOST) return HOST;
  if (host === CONTAINER_HOST) return CONTAINER_HOST;
  throw new Error(`VIGIL_HOST must be ${HOST} or ${CONTAINER_HOST} (the Docker image), got ${host}`);
}

/** An error with an API error code; anything else thrown in a route becomes `internal`. */
export class ApiError extends Error {
  override name = "ApiError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function errorBody(code: ErrorCode, message: string, details: Record<string, unknown> = {}): ErrorResponse {
  return { error: { code, message, details } };
}

export type Routes = (v1: Hono) => void;

export interface AppOptions {
  /** Registers the route modules on the `/v1` app. */
  routes?: Routes[];
  /**
   * Evaluated on every readiness request; omitted means not ready.
   * Return true only while Zova and DuckDB are open and available, Zova application schema migrations have
   * succeeded, and DuckDB migrations and initialization (including required views) have succeeded.
   * The process owner (#168) tracks this lifecycle: return false during startup, known initialization failures
   * and shutdown. Unexpected exceptions use the common internal error handler.
   */
  isReady?: () => boolean;
  /** Called with errors that become `internal`, for the log (#196). */
  onInternalError?: (error: unknown) => void;
}

/** The Hono app; `fetch` it in tests, `serve` it in the server process. */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const v1 = new Hono();
  // Register first and finish the response so external routes cannot shadow these endpoints.
  v1.get("/health", (c) => c.json({ status: "ok" }, 200));
  v1.get("/ready", (c) => {
    if (options.isReady?.() !== true) throw new ApiError("not_ready", "Sunucu henüz hazır değil.");
    return c.json({ status: "ok" }, 200);
  });
  for (const register of options.routes ?? []) register(v1);
  app.route("/v1", v1);

  app.notFound((c) => c.json(errorBody("not_found", `Bulunamadı: ${c.req.path}`), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), ERROR_STATUS[err.code] as ContentfulStatusCode);
    }
    options.onInternalError?.(err);
    // The message of an unexpected error is not sent: it can contain paths or data.
    return c.json(errorBody("internal", "Beklenmeyen bir hata oluştu."), 500);
  });
  return app;
}

export interface RunningServer {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/** Listen on 127.0.0.1 (or `CONTAINER_HOST` in the Docker image). `port: 0` picks a free port (tests). */
export function serve(app: Hono, port = DEFAULT_PORT, hostname = HOST): RunningServer {
  const server = Bun.serve({ hostname, port, fetch: app.fetch });
  return {
    // Reached on 127.0.0.1 in both cases.
    url: `http://${HOST}:${server.port}`,
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

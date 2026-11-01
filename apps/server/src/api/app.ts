/**
 * The HTTP API (#212, docs/API.md): a Hono app under `/v1`, served on 127.0.0.1 only (decision 0008).
 * Routes are added by their own modules through `routes`; this file owns the prefix, the error format and the
 * listener.
 */
import type { ErrorCode, ErrorResponse } from "@vigil/api-types";
import { ERROR_STATUS } from "@vigil/api-types";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** The only interface the API listens on. Not configurable: the local release is not reachable from outside. */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 8787;

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
  /** Called with errors that become `internal`, for the log (#196). */
  onInternalError?: (error: unknown) => void;
}

/** The Hono app; `fetch` it in tests, `serve` it in the server process. */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const v1 = new Hono();
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

/** Listen on 127.0.0.1. `port: 0` picks a free port (tests). */
export function serve(app: Hono, port = DEFAULT_PORT): RunningServer {
  const server = Bun.serve({ hostname: HOST, port, fetch: app.fetch });
  return {
    url: `http://${HOST}:${server.port}`,
    port: server.port as number,
    stop: () => server.stop(true),
  };
}

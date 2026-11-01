/** Hono app skeleton (#212): /v1 prefix, one error format, 127.0.0.1 only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import type { ErrorResponse } from "@vigil/api-types";
import { ApiError, createApp, HOST, type Routes, type RunningServer, serve } from "../src/api/app.ts";

const internal: unknown[] = [];
const testRoutes: Routes = (v1) => {
  v1.get("/ping", (c) => c.json({ pong: true }));
  v1.get("/missing", () => {
    throw new ApiError("not_found", "Şirket bulunamadı: XYZ", { code: "XYZ" });
  });
  v1.get("/bad", () => {
    throw new ApiError("invalid_request", "limit 200'den büyük olamaz", { parameter: "limit" });
  });
  v1.get("/boom", () => {
    throw new Error("secret path C:/Users/someone/data");
  });
};
const app = createApp({ routes: [testRoutes], onInternalError: (e) => internal.push(e) });

const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));
const body = async (r: Response) => (await r.json()) as ErrorResponse;

describe("createApp", () => {
  test("routes live under /v1", async () => {
    expect(await (await get("/v1/ping")).json()).toEqual({ pong: true });
    expect((await get("/ping")).status).toBe(404);
  });

  test("an ApiError becomes its status and the common error body", async () => {
    let r = await get("/v1/missing");
    expect(r.status).toBe(404);
    expect(await body(r)).toEqual({
      error: { code: "not_found", message: "Şirket bulunamadı: XYZ", details: { code: "XYZ" } },
    });
    r = await get("/v1/bad");
    expect(r.status).toBe(400);
    expect((await body(r)).error.details).toEqual({ parameter: "limit" });
  });

  test("an unknown path is a not_found error", async () => {
    const r = await get("/v1/nothing-here");
    expect(r.status).toBe(404);
    expect((await body(r)).error.code).toBe("not_found");
  });

  test("an unexpected error is internal, logged, and its message is not sent", async () => {
    const r = await get("/v1/boom");
    expect(r.status).toBe(500);
    const b = await body(r);
    expect(b.error.code).toBe("internal");
    expect(JSON.stringify(b)).not.toContain("secret");
    expect(internal).toHaveLength(1);
  });
});

describe("serve", () => {
  let server: RunningServer;
  beforeAll(() => {
    server = serve(app, 0);
  });
  afterAll(() => server.stop());

  test("answers on 127.0.0.1", async () => {
    expect(server.url.startsWith(`http://${HOST}:`)).toBe(true);
    expect(await (await fetch(`${server.url}/v1/ping`)).json()).toEqual({ pong: true });
  });

  test("does not answer on the machine's other addresses", async () => {
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && a.family === "IPv4" && !a.internal)
      .map((a) => a?.address as string);
    for (const address of others) {
      const result = await fetch(`http://${address}:${server.port}/v1/ping`, {
        signal: AbortSignal.timeout(2000),
      }).then(
        () => "answered",
        () => "refused",
      );
      expect(`${address}: ${result}`).toBe(`${address}: refused`);
    }
  });
});

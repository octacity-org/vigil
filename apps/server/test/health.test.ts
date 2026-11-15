/**
 * Health and readiness endpoints (#200). Expected behaviour is `docs/API.md`: `GET /v1/health` answers
 * `{ "status": "ok" }` while the process runs; `GET /v1/ready` answers 200 when the server is ready, else 503
 * `not_ready` in the common error format.
 */
import { describe, expect, test } from "bun:test";
import type { ErrorResponse } from "@vigil/api-types";
import { type AppOptions, createApp } from "../src/api/app.ts";

const get = (options: AppOptions, path: string) => createApp(options).fetch(new Request(`http://localhost${path}`));

async function expectNotReady(r: Response) {
  expect(r.status).toBe(503);
  const b = (await r.json()) as ErrorResponse;
  expect(b.error.code).toBe("not_ready");
  expect(typeof b.error.message).toBe("string");
  expect(b.error.message.length).toBeGreaterThan(0);
}

describe("GET /v1/health", () => {
  test("answers 200 with status ok", async () => {
    const r = await get({}, "/v1/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  test("does not depend on readiness: it answers while the server is not ready, and does not ask", async () => {
    let asked = 0;
    const r = await get(
      {
        isReady: () => {
          asked++;
          return false;
        },
      },
      "/v1/health",
    );
    expect(r.status).toBe(200);
    expect(asked).toBe(0);
  });

  test("lives under /v1 only", async () => {
    expect((await get({}, "/health")).status).toBe(404);
  });
});

describe("GET /v1/ready", () => {
  test("not ready when no readiness check is given", async () => {
    await expectNotReady(await get({}, "/v1/ready"));
  });

  test("not ready while the check says false", async () => {
    await expectNotReady(await get({ isReady: () => false }, "/v1/ready"));
  });

  test("200 with status ok when the check says true", async () => {
    const r = await get({ isReady: () => true }, "/v1/ready");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  test("the check is asked on every request, so the answer follows start-up and shutdown", async () => {
    let ready = false;
    const app = createApp({ isReady: () => ready });
    const ask = () => app.fetch(new Request("http://localhost/v1/ready"));
    await expectNotReady(await ask());
    ready = true;
    expect((await ask()).status).toBe(200);
    ready = false;
    await expectNotReady(await ask());
  });

  test("a check that throws is an internal error, logged, with its message not sent", async () => {
    const logged: unknown[] = [];
    const r = await get(
      {
        isReady: () => {
          throw new Error("secret path C:/Users/someone/data");
        },
        onInternalError: (e) => logged.push(e),
      },
      "/v1/ready",
    );
    expect(r.status).toBe(500);
    const text = await r.text();
    expect((JSON.parse(text) as ErrorResponse).error.code).toBe("internal");
    expect(text).not.toContain("secret");
    expect(logged).toHaveLength(1);
  });
});

test("route modules cannot replace the health and readiness endpoints", async () => {
  const options: AppOptions = {
    isReady: () => false,
    routes: [
      (v1) => {
        v1.get("/health", (c) => c.json({ status: "shadowed" }));
        v1.get("/ready", (c) => c.json({ status: "shadowed" }));
      },
    ],
  };
  expect(await (await get(options, "/v1/health")).json()).toEqual({ status: "ok" });
  await expectNotReady(await get(options, "/v1/ready"));
});

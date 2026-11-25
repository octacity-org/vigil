/**
 * Paging and sorting for list endpoints (#215, #372), tested apart from their author (CONTRIBUTING rule 5). Expected
 * values are written by hand from docs/API.md ("Lists"): `limit` 1–200, default 50; an opaque cursor; `sort` is a
 * field name, `-` for descending; `next_cursor` is null on the last page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ErrorResponse, ListResponse } from "@vigil/api-types";
import { ApiError, createApp, type Routes } from "../src/api/app.ts";
import {
  DEFAULT_LIMIT,
  decodeCursor,
  encodeCursor,
  type ListQuery,
  listResponse,
  MAX_LIMIT,
  pageSql,
  parseListQuery,
} from "../src/api/paging.ts";
import { close, connect, type Database, rows } from "../src/db.ts";

const FIELDS = ["code", "size"] as const;
type Field = (typeof FIELDS)[number];

/** A route that only echoes the parsed query, to test `parseListQuery` through real requests. */
const echo: Routes = (v1) => {
  v1.get("/echo", (c) => c.json(parseListQuery(c, FIELDS, "-size")));
};
const echoApp = createApp({ routes: [echo] });

async function query(qs: string) {
  const r = await echoApp.request(`/v1/echo${qs}`);
  return { status: r.status, body: (await r.json()) as ListQuery<Field> & ErrorResponse };
}

async function rejected(qs: string, parameter: string) {
  const { status, body } = await query(qs);
  expect(status).toBe(400);
  expect(body.error.code).toBe("invalid_request");
  expect(body.error.details.parameter).toBe(parameter);
  return body.error;
}

describe("parseListQuery", () => {
  test("defaults: limit 50, first page, the list's default sort", async () => {
    expect(DEFAULT_LIMIT).toBe(50);
    expect(MAX_LIMIT).toBe(200);
    expect((await query("")).body as unknown).toEqual({ limit: 50, offset: 0, sort: "size", descending: true });
    expect((await query("?sort=")).body as unknown).toEqual({ limit: 50, offset: 0, sort: "size", descending: true });
  });

  test("limit from 1 to 200", async () => {
    expect((await query("?limit=1")).body.limit).toBe(1);
    expect((await query("?limit=200")).body.limit).toBe(200);
    for (const limit of ["0", "201", "-1", "1.5", "abc", "1e2"]) await rejected(`?limit=${limit}`, "limit");
  });

  test("sort by a field, '-' for descending", async () => {
    expect((await query("?sort=code")).body).toMatchObject({ sort: "code", descending: false });
    expect((await query("?sort=-code")).body).toMatchObject({ sort: "code", descending: true });
    expect((await query("?sort=size")).body).toMatchObject({ sort: "size", descending: false });
  });

  test("a field the list does not have is refused, with the allowed fields", async () => {
    for (const sort of ["title", "--size", "-", "SIZE", "size;DROP TABLE t"]) {
      const e = await rejected(`?sort=${encodeURIComponent(sort)}`, "sort");
      expect(e.details.allowed).toEqual(["code", "size"]);
    }
  });

  test("the cursor gives the offset", async () => {
    expect((await query(`?cursor=${encodeCursor(40)}`)).body.offset).toBe(40);
  });
});

describe("cursor", () => {
  test("round trip, and no cursor is the first page", () => {
    for (const offset of [0, 1, 50, 199, 1_000_000]) expect(decodeCursor(encodeCursor(offset))).toBe(offset);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor("")).toBe(0);
  });

  test("the cursor is URL-safe text", () => {
    expect(encodeCursor(123456)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a cursor the server did not make is a 400", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    for (const raw of [
      "!!!",
      "abc",
      b64("{}"),
      b64("null"),
      b64("[]"),
      b64('{"offset":-1}'),
      b64('{"offset":1.5}'),
      b64('{"offset":"10"}'),
      b64(`{"offset":${2 ** 53}}`),
    ]) {
      let thrown: unknown;
      try {
        decodeCursor(raw);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).code).toBe("invalid_request");
      expect((thrown as ApiError).details.parameter).toBe("cursor");
    }
  });
});

describe("pageSql", () => {
  const columns: Record<Field, string> = { code: "company_code", size: "abs(size_bps)" };

  test("ascending and descending, with the tiebreak, limit and offset", () => {
    expect(pageSql({ limit: 2, offset: 4, sort: "code", descending: false }, columns, "id")).toBe(
      "ORDER BY company_code ASC NULLS LAST, id LIMIT 2 OFFSET 4",
    );
    expect(pageSql({ limit: 50, offset: 0, sort: "size", descending: true }, columns, "id")).toBe(
      "ORDER BY abs(size_bps) DESC NULLS LAST, id LIMIT 50 OFFSET 0",
    );
  });
});

describe("listResponse", () => {
  const q = (offset: number, limit = 2): ListQuery<string> => ({ limit, offset, sort: "code", descending: false });

  test("next_cursor on every page but the last", () => {
    expect(listResponse(["a", "b"], 5, q(0))).toEqual({ items: ["a", "b"], next_cursor: encodeCursor(2), total: 5 });
    expect(listResponse(["c", "d"], 5, q(2)).next_cursor).toBe(encodeCursor(4));
    expect(listResponse(["e"], 5, q(4))).toEqual({ items: ["e"], next_cursor: null, total: 5 });
  });

  test("an exactly full last page and an empty page have no next page", () => {
    expect(listResponse(["c", "d"], 4, q(2)).next_cursor).toBeNull();
    expect(listResponse([], 0, q(0))).toEqual({ items: [], next_cursor: null, total: 0 });
    expect(listResponse([], 5, q(10)).next_cursor).toBeNull();
  });
});

describe("paging through a DuckDB table", () => {
  // Seven rows; sizes repeat so the tiebreak decides their order.
  const DATA: [number, string, number | null][] = [
    [1, "KATMR", -2596],
    [2, "AKBNK", 1200],
    [3, "DOHOL", 1200],
    [4, "BIOEN", null],
    [5, "MOGAN", -1200],
    [6, "SANFM", 3000],
    [7, "AKENR", 1200],
  ];
  const columns: Record<Field, string> = { code: "code", size: "abs(size_bps)" };
  let db: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await connect(":memory:");
    await rows(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, code VARCHAR, size_bps INTEGER)");
    for (const [id, code, size] of DATA) await rows(db, "INSERT INTO t VALUES ($1, $2, $3)", [id, code, size]);
    const list: Routes = (v1) => {
      v1.get("/list", async (c) => {
        const query = parseListQuery(c, FIELDS, "-size");
        const page = await rows(db, `SELECT code FROM t ${pageSql(query, columns, "id")}`);
        const [{ n }] = (await rows(db, "SELECT count(*) AS n FROM t")) as [{ n: bigint }];
        return c.json(
          listResponse(
            page.map((r) => r.code as string),
            Number(n),
            query,
          ),
        );
      });
    };
    app = createApp({ routes: [list] });
  });
  afterAll(() => close(db));

  async function all(qs: string): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const sep = qs ? "&" : "?";
      const r = await app.request(`/v1/list${qs}${cursor ? `${sep}cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as ListResponse<string>;
      expect(body.total).toBe(7);
      pages.push(body.items);
      cursor = body.next_cursor;
      expect(pages.length).toBeLessThan(10);
    } while (cursor !== null);
    return pages;
  }

  test("largest change first by default; equal sizes in id order; no value last", async () => {
    expect(await all("?limit=3")).toEqual([["SANFM", "KATMR", "AKBNK"], ["DOHOL", "MOGAN", "AKENR"], ["BIOEN"]]);
  });

  test("by code, both directions, every row once", async () => {
    expect((await all("?sort=code&limit=2")).flat()).toEqual([
      "AKBNK",
      "AKENR",
      "BIOEN",
      "DOHOL",
      "KATMR",
      "MOGAN",
      "SANFM",
    ]);
    expect((await all("?sort=-code&limit=200")).flat()).toEqual([
      "SANFM",
      "MOGAN",
      "KATMR",
      "DOHOL",
      "BIOEN",
      "AKENR",
      "AKBNK",
    ]);
  });

  test("a sort the list does not have never reaches the SQL", async () => {
    const r = await app.request(`/v1/list?sort=${encodeURIComponent("code; DROP TABLE t")}`);
    expect(r.status).toBe(400);
    const [{ n }] = (await rows(db, "SELECT count(*) AS n FROM t")) as [{ n: bigint }];
    expect(n).toBe(7n);
  });
});

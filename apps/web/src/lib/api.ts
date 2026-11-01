/**
 * The web app's only way to reach the Vigil API (#232, docs/API.md). Pages and components call these functions;
 * nothing else in `src` calls `fetch` (a test guards it).
 *
 * - Typed by `@vigil/api-types`, so a contract change breaks the type check here.
 * - Errors: every failure becomes an `ApiClientError` with the API's error code; network failures and bad
 *   responses get their own codes, so pages handle one type.
 * - Amounts stay strings in responses; read them with `toBigInt` (one place), never `Number()`.
 */
import {
  type Company,
  type CompanyDetail,
  type DownloadRequest,
  type ErrorCode,
  type ErrorResponse,
  type FactVersionsResponse,
  type Finding,
  type FindingDetail,
  type FindingFilters,
  type Health,
  type ListParams,
  type ListResponse,
  type Meta,
  type MetricsResponse,
  parseAmount,
  type QualityResponse,
  type Report,
  type Settings,
  type SettingsUpdate,
  type Statement,
  type StatementName,
  type Value,
  type VersionSelector,
} from "@vigil/api-types";

/** The server listens on 127.0.0.1 only (decision 0008). */
export const DEFAULT_API_URL = "http://127.0.0.1:8787";

export type ClientErrorCode = ErrorCode | "network" | "bad_response";

export class ApiClientError extends Error {
  override name = "ApiClientError";
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: number | null,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl?: string;
  /** Replaceable in tests. */
  fetch?: Fetch;
}

/** Query parameters: any object whose values are strings, numbers or undefined. */
type Query = { [key: string]: string | number | undefined } | object;

function queryString(q: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q) as [string, unknown][])
    if (v !== undefined && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
}

const seg = (s: string) => encodeURIComponent(s);

function isErrorResponse(x: unknown): x is ErrorResponse {
  const e = (x as ErrorResponse | null)?.error;
  return typeof e === "object" && e !== null && typeof e.code === "string" && typeof e.message === "string";
}

export function createClient(options: ClientOptions = {}) {
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const doFetch: Fetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
    let resp: Response;
    try {
      resp = await doFetch(`${base}${path}`, {
        method,
        headers:
          body === undefined
            ? { Accept: "application/json" }
            : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiClientError("network", `Vigil sunucusuna ulaşılamadı: ${(e as Error).message}`, null);
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      throw new ApiClientError("bad_response", `Sunucudan beklenmeyen yanıt (HTTP ${resp.status}).`, resp.status);
    }
    if (!resp.ok) {
      if (isErrorResponse(data)) {
        throw new ApiClientError(data.error.code, data.error.message, resp.status, data.error.details);
      }
      throw new ApiClientError("bad_response", `Sunucudan beklenmeyen yanıt (HTTP ${resp.status}).`, resp.status);
    }
    return data as T;
  }

  const get = <T>(path: string, q?: Query) => request<T>("GET", path + queryString(q));

  return {
    health: () => get<Health>("/v1/health"),
    ready: () => get<Health>("/v1/ready"),
    meta: () => get<Meta>("/v1/meta"),
    companies: (q: { q?: string } & ListParams = {}) => get<ListResponse<Company>>("/v1/companies", q),
    company: (code: string) => get<CompanyDetail>(`/v1/companies/${seg(code)}`),
    metrics: (code: string, q: { period?: string; version?: VersionSelector } = {}) =>
      get<MetricsResponse>(`/v1/companies/${seg(code)}/metrics`, q),
    factVersions: (code: string, row: string, q: { period_end?: string; currency_part?: string } = {}) =>
      get<FactVersionsResponse>(`/v1/companies/${seg(code)}/facts/${seg(row)}/versions`, q),
    report: (documentId: string) => get<Report>(`/v1/reports/${seg(documentId)}`),
    statement: (documentId: string, statement: StatementName, q: { view?: "cumulative" | "three_month" } = {}) =>
      get<Statement>(`/v1/reports/${seg(documentId)}/statements/${statement}`, q),
    findings: (q: FindingFilters = {}) => get<ListResponse<Finding>>("/v1/findings", q),
    finding: (id: string) => get<FindingDetail>(`/v1/findings/${seg(id)}`),
    quality: (q: { quarter?: string } = {}) => get<QualityResponse>("/v1/quality", q),
    settings: () => get<Settings>("/v1/settings"),
    updateSettings: (update: SettingsUpdate) => request<Settings>("PUT", "/v1/settings", update),
    startDownload: (req: DownloadRequest) => request<{ started: string[] }>("POST", "/v1/downloads", req),
    /** URL for the server-sent download events (#227); open it with `EventSource`. */
    downloadEventsUrl: () => `${base}/v1/downloads/events`,
  };
}

export type ApiClient = ReturnType<typeof createClient>;

/** The client the app uses. `NEXT_PUBLIC_API_URL` overrides the address (Docker, #262). */
export const api: ApiClient = createClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL });

/** The one place an amount string becomes a bigint. `null` unless the value is `ok`. */
export function toBigInt(v: Value): bigint | null {
  return v.status === "ok" ? parseAmount(v.value) : null;
}

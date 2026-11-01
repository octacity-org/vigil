/**
 * The only way the server talks to KAP (#199, decision 0008, docs/kap.md "Politeness").
 *
 * The rules are constants, not settings: one request at a time, at least a second between requests, a few retries
 * with growing waits on network errors, 429 and 5xx. Tests replace the transport and the clock, never the rules.
 */

export const KAP_ORIGIN = "https://www.kap.org.tr";

/** Wait between the end of one request and the start of the next. */
export const MIN_INTERVAL_MS = 1_000;
/** Attempts per request for network errors, 429 and 5xx. */
export const MAX_ATTEMPTS = 3;
/** Wait before the first retry; doubles after each one. A `Retry-After` header is used when it is longer. */
export const RETRY_BASE_MS = 2_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json,application/zip,application/octet-stream,*/*",
  Referer: "https://www.kap.org.tr/tr/",
};

/** Sends one HTTP request; replaceable in tests. */
export type Transport = (url: string, init: RequestInit & { timeoutMs: number }) => Promise<Response>;

const fetchTransport: Transport = (url, { timeoutMs, ...init }) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

export interface KapClientOptions {
  transport?: Transport;
  /** Waits `ms`; replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Current time in ms; replaceable in tests. */
  now?: () => number;
}

export interface KapRequest {
  method?: "GET" | "POST";
  /** Sent as JSON. */
  json?: unknown;
  timeoutMs?: number;
  /** Fewer attempts than MAX_ATTEMPTS, for callers that retry on their own (the bulk download). Never more. */
  attempts?: number;
}

export class KapError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "KapError";
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfterMs(resp: Response): number {
  const value = Number(resp.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

export class KapClient {
  readonly #transport: Transport;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #lastEnd = Number.NEGATIVE_INFINITY;

  constructor(options: KapClientOptions = {}) {
    this.#transport = options.transport ?? fetchTransport;
    this.#sleep = options.sleep ?? realSleep;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Send a request to a KAP path (`/tr/api/...`) and hand the response to `use`. The next request starts only after
   * `use` has finished, so a streamed body is never read while another request is running.
   */
  request<T>(path: string, use: (resp: Response) => Promise<T>, req: KapRequest = {}): Promise<T> {
    if (!path.startsWith("/")) throw new KapError(`not a KAP path: ${path}`, null);
    const run = () => this.#run(KAP_ORIGIN + path, use, req);
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /** GET or POST a path and parse the JSON answer. */
  json<T = unknown>(path: string, req: KapRequest = {}): Promise<T> {
    return this.request(path, (resp) => resp.json() as Promise<T>, req);
  }

  async #run<T>(url: string, use: (resp: Response) => Promise<T>, req: KapRequest): Promise<T> {
    const headers: Record<string, string> = { ...DEFAULT_HEADERS };
    if (req.json !== undefined) headers["Content-Type"] = "application/json";
    const init = {
      method: req.method ?? (req.json === undefined ? "GET" : "POST"),
      headers,
      body: req.json === undefined ? undefined : JSON.stringify(req.json),
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
    try {
      for (let attempt = 1; ; attempt++) {
        const wait = this.#lastEnd + MIN_INTERVAL_MS - this.#now();
        if (wait > 0) await this.#sleep(wait);
        let resp: Response | null = null;
        let error: KapError;
        try {
          resp = await this.#transport(url, init);
          if (resp.ok) return await use(resp);
          error = new KapError(`HTTP ${resp.status} from ${url}`, resp.status);
          if (!retryable(resp.status)) throw error;
        } catch (e) {
          if (e instanceof KapError && !retryable(e.status ?? 500)) throw e;
          if (resp?.ok) throw e; // failed while reading the body: the caller decides
          error = e instanceof KapError ? e : new KapError(`${(e as Error).name}: ${(e as Error).message}`, null);
        } finally {
          this.#lastEnd = this.#now();
        }
        if (attempt >= Math.min(req.attempts ?? MAX_ATTEMPTS, MAX_ATTEMPTS)) throw error;
        const backoff = RETRY_BASE_MS * 2 ** (attempt - 1);
        await this.#sleep(Math.max(backoff, resp ? retryAfterMs(resp) : 0));
      }
    } finally {
      this.#lastEnd = this.#now();
    }
  }
}

/** The client shared by the whole server process, so all KAP requests wait in one queue. */
export const kap = new KapClient();

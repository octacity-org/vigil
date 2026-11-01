/**
 * Shapes of the HTTP API (docs/API.md, #213). Used by the server routes and the web client, so a change to a
 * response breaks the type check on both sides. Edit this file and docs/API.md in the same PR.
 *
 * Amounts are integer strings: the server holds them as bigint, and JSON numbers lose precision above 2^53.
 * Use `amount()` to write one and `parseAmount()` to read one; never `Number()`.
 */

// ---- Shared objects ------------------------------------------------------------------------------------------

export type IsoDate = string; // "2026-06-30"
export type IsoTime = string; // "2026-08-17T16:05:18Z"
/** Integer TL amount, as a string ("189492068"). */
export type AmountString = string;
/** Decimal with fixed digits, as a string ("0.215430"). */
export type DecimalString = string;

export type Unit = "TRY" | "ratio" | "bps" | "days" | "count";
export type ValueStatus = "ok" | "not_reported" | "not_computable";
export type PeriodType = "point_in_time" | "cumulative" | "three_month";
export type CurrencyPart = "total" | "tp" | "yp";
export type Consolidation = "consolidated" | "solo";
export type Template = "general" | "banks" | "par-banks" | "finance" | "holding" | "insurance";

export type ReasonCode =
  | "missing_input"
  | "zero_denominator"
  | "template_not_supported"
  | "period_mismatch"
  | "blocked_by_check"
  | "not_applicable";

export interface Reason {
  code: ReasonCode;
  /** Turkish, for the UI. */
  message: string;
  /** Inputs that would make the value computable. */
  needs: string[];
}

export interface Period {
  /** `null` for a point in time. */
  start: IsoDate | null;
  end: IsoDate;
  type: PeriodType;
  /** The column header as filed. */
  label: string;
  currency_part: CurrencyPart;
}

export interface Source {
  system: string; // "KAP"
  document_id: string;
  company_code: string;
  report: { year: number; quarter: number; consolidation: Consolidation };
  table: string;
  row: string;
  row_label: string;
  column: string;
  period_label: string;
  /** Text in the cell as filed, before scaling. */
  shown_value: string;
  scale: string;
  published_at: IsoTime | null;
  url: string;
}

export interface Definition {
  id: string;
  version: string;
  url: string;
}

/** A step is either an input value or a formula over earlier steps. */
export type CalculationStep =
  | { id: string; label: string; value: Value }
  | { id: string; label: string; formula: string; result: string };

export interface Calculation {
  formula: string;
  definition: Definition;
  steps: CalculationStep[];
}

interface ValueBase {
  unit: Unit;
  period?: Period;
}

/** Every number the API returns. Read values have `source`, computed values have `calculation`, never both. */
export type Value = ValueBase &
  (
    | { status: "ok"; value: string; source?: Source; calculation?: Calculation }
    | { status: "not_reported"; value: null; source?: Source }
    | { status: "not_computable"; value: null; reason: Reason; calculation?: Calculation }
  );

export interface ListResponse<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  /** Field name, `-` prefix for descending. */
  sort?: string;
}

/** `latest` (default), `first`, or `report:{document_id}`. */
export type VersionSelector = "latest" | "first" | `report:${string}`;

export type ErrorCode = "invalid_request" | "not_found" | "conflict" | "not_ready" | "internal";

export interface ErrorResponse {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> };
}

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  not_ready: 503,
  internal: 500,
};

// ---- Resources -----------------------------------------------------------------------------------------------

export type Quality = "pass" | "fail" | "known_error" | "not_checked" | "parse_error" | "no_values";

export interface ReportRef {
  document_id: string;
  year: number;
  quarter: number;
  quality: Quality;
}

export interface Company {
  code: string;
  codes: string[];
  title: string | null;
  template: Template;
  sector: string | null;
  member_id: string | null;
  latest_report: ReportRef | null;
}

export interface CompanyReport extends ReportRef {
  consolidation: Consolidation;
  published_at: IsoTime | null;
  /** The document this report corrects, or null. */
  corrects: string | null;
}

export interface CompanyDetail extends Company {
  reports: CompanyReport[];
}

export interface Check {
  name: string;
  group: string;
  severity: "blocking" | "informational";
  status: "pass" | "fail" | "not_checked";
  left: Value | null;
  right: Value | null;
  /** In TL, as an amount string. */
  tolerance: AmountString;
  /** Reason when the failure is a known filing error (decision 0006). */
  known_error: string | null;
}

export interface Report {
  document_id: string;
  company_code: string;
  year: number;
  quarter: number;
  consolidation: Consolidation;
  template: Template;
  scale: string;
  published_at: IsoTime | null;
  quality: Quality;
  checks: Check[];
  url: string;
}

export type StatementName =
  | "balance_sheet"
  | "income_statement"
  | "comprehensive_income"
  | "cash_flow"
  | "equity_changes";

export interface StatementColumn {
  id: string;
  period: Period;
  comparative: boolean;
}

export interface StatementRow {
  row: string;
  label: string;
  level: number;
  subtotal: boolean;
  values: Record<string, Value>;
}

export interface Statement {
  document_id: string;
  statement: StatementName;
  columns: StatementColumn[];
  rows: StatementRow[];
}

export interface Metric {
  id: string;
  label: string;
  value: Value;
}

export interface MetricsResponse {
  company_code: string;
  period_end: IsoDate;
  metrics: Metric[];
}

export interface FactVersion {
  version_no: number;
  value: Value;
  /** Report the version comes from. */
  report: { document_id: string; year: number; quarter: number; published_at: IsoTime | null };
}

export interface FactVersionsResponse {
  company_code: string;
  row: string;
  period: Period;
  versions: FactVersion[];
}

export type RuleId = "gross_margin_change" | "profit_cash_divergence" | "restated_comparatives";

export interface Finding {
  id: string;
  rule: RuleId;
  title: string;
  company_code: string;
  document_id: string;
  year: number;
  quarter: number;
  template: Template;
  size: Value;
  /** States the change; never says what to do. */
  headline: string;
  config_version: string;
  created_at: IsoTime;
}

export interface FindingDetail extends Finding {
  calculation: Calculation;
  thresholds: Record<string, string | number>;
  methodology_url: string;
}

export interface FindingFilters extends ListParams {
  rule?: RuleId;
  template?: Template;
  /** "2026-2" */
  quarter?: string;
  company?: string;
}

export interface QualityQuarter {
  quarter: string;
  counts: Partial<Record<Quality, number>>;
  files: { file: string; status: Quality; reason: string | null }[];
}

export interface QualityResponse {
  quarters: QualityQuarter[];
}

export interface Meta {
  app_version: string;
  config_version: string;
  quarters: { quarter: string; files: number; quality: Partial<Record<Quality, number>> }[];
}

/**
 * Where LLM features run (#253). Vigil is not tied to one company:
 * - `anthropic`, `gemini`: the provider's API with the user's key;
 * - `openai_compatible`: any service with an OpenAI-style API (OpenRouter, OpenCode, Groq and others), at `base_url`;
 * - `ollama`: a model on the user's computer, no key, nothing leaves the computer.
 */
export type LlmProvider = "anthropic" | "gemini" | "openai_compatible" | "ollama";

export interface LlmSettings {
  provider: LlmProvider;
  /** Model name as the provider expects it. */
  model: string;
  /** Required for `openai_compatible`; `ollama` defaults to http://127.0.0.1:11434; `null` for the others. */
  base_url: string | null;
  /** Write-only: GET returns only whether a key is set. */
  api_key_set: boolean;
}

export interface LlmSettingsUpdate {
  provider: LlmProvider;
  model: string;
  base_url?: string | null;
  /** Set a key, or `null` to remove it. Never returned. Not needed for `ollama`. */
  api_key?: string | null;
}

export interface Settings {
  data_dir: string;
  quarters: string[];
  /** `null` when LLM features are off (the default). */
  llm: LlmSettings | null;
}

export interface SettingsUpdate {
  quarters?: string[];
  /** Choose a provider, or `null` to turn LLM features off. */
  llm?: LlmSettingsUpdate | null;
}

export interface DownloadRequest {
  quarters: string[];
}

export type DownloadEvent =
  | { type: "progress"; quarter: string; done: number; total: number }
  | { type: "error"; quarter: string; file: string | null; message: string }
  | { type: "done"; quarter: string; stored: number; failed: number };

export interface Health {
  status: "ok";
}

/** Path and response type of every GET endpoint, for typed clients. */
export interface GetRoutes {
  "/v1/health": Health;
  "/v1/ready": Health;
  "/v1/meta": Meta;
  "/v1/companies": ListResponse<Company>;
  "/v1/companies/{code}": CompanyDetail;
  "/v1/companies/{code}/metrics": MetricsResponse;
  "/v1/companies/{code}/facts/{row}/versions": FactVersionsResponse;
  "/v1/reports/{document_id}": Report;
  "/v1/reports/{document_id}/statements/{statement}": Statement;
  "/v1/findings": ListResponse<Finding>;
  "/v1/findings/{id}": FindingDetail;
  "/v1/quality": QualityResponse;
  "/v1/settings": Settings;
}

// ---- Helpers -------------------------------------------------------------------------------------------------

const INTEGER = /^-?(0|[1-9]\d*)$/;

/** Write a bigint amount for the API. */
export function amount(v: bigint): AmountString {
  return v.toString();
}

/** Read an amount string back into a bigint. Throws on anything that is not an integer string. */
export function parseAmount(s: string): bigint {
  if (!INTEGER.test(s)) throw new TypeError(`not an amount: ${JSON.stringify(s)}`);
  return BigInt(s);
}

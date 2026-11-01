# API contract

The HTTP API between the Vigil server (`apps/server`) and the web app (`apps/web`). Both build against this document (#161). Principles are in [`ARCHITECTURE.md`](ARCHITECTURE.md#api); this page is the detail. Types for every shape here live in [`packages/api-types`](../packages/api-types/src/index.ts) (#213), used by the server and the web app, so a mismatch between them fails the type check. Its tests parse the example below and check it against the types.

Status: **v1 draft for the local release.** Changes to shapes go through a PR that edits this file and the shared types together.

## Conventions

- **Base path** `/v1`. Served on `127.0.0.1` only (decision 0008). Read-only except settings and downloads.
- **JSON**, UTF-8. Field names are `snake_case`.
- **Amounts are strings.** Every TL amount is an integer string (`"189492068"`), because JavaScript numbers lose precision above 2^53 and amounts are `bigint` in the server. Ratios are decimal strings with fixed digits (`"0.215430"`). Counts and basis points are JSON numbers.
- **Dates** are ISO 8601: `"2026-06-30"`; times are UTC with `Z`: `"2026-08-17T16:05:18Z"`.
- **Missing is never 0.** A value that is not there has a status saying why (see [Value](#value)).
- **Market-neutral names.** Nothing in a field name says KAP or Türkiye; the source system is a field value (`"source": {"system": "KAP"}`), so a second source (US filings, Phase 5) fits without renaming.
- **Findings, not signals.** The resource is `findings`. Rule codes S1–S3 are internal; the API exposes neutral rule ids (`gross_margin_change`) and Turkish titles that describe a change, never a recommendation (`docs/legal.md`).

## Shared objects

### Value

Every number the API returns is a `Value`. The UI never formats a bare number.

```json
{
  "value": "189492068",
  "unit": "TRY",
  "status": "ok",
  "period": { "start": "2026-04-01", "end": "2026-06-30", "type": "three_month" },
  "source": { "...": "see Source" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `value` | string or `null` | The value; `null` unless `status` is `ok` |
| `unit` | `"TRY"`, `"ratio"`, `"bps"`, `"days"`, `"count"` | `TRY` amounts are whole TL after scaling (`Sunum Para Birimi`) |
| `status` | `"ok"`, `"not_reported"`, `"not_computable"` | `not_reported`: the company left the cell empty. `not_computable`: Vigil cannot compute it |
| `reason` | Reason, only when `not_computable` | Why, and what data would be needed |
| `period` | Period | What the value describes |
| `source` | Source, for values read from a filing | Where it was read |
| `calculation` | Calculation, for computed values | How it was computed |

A value has either `source` (read) or `calculation` (computed), never both.

**Reason**

```json
{ "code": "missing_input", "message": "Satışların maliyeti raporda yok.", "needs": ["cost_of_sales"] }
```

`code` is one of `missing_input`, `zero_denominator`, `template_not_supported`, `period_mismatch`, `blocked_by_check` (the report failed a blocking check, #19), `not_applicable` (e.g. gross margin for a bank). `message` is Turkish, for the UI. `needs` lists the inputs that would make it computable.

### Period

| Field | Type | Meaning |
|---|---|---|
| `start` | date or `null` | `null` for a point in time |
| `end` | date | |
| `type` | `"point_in_time"`, `"cumulative"`, `"three_month"` | Balance sheet values are points in time; income and cash flow are cumulative from the fiscal year start or the 3 months of the quarter |
| `label` | string | The column header as filed, e.g. `"Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026"` |
| `currency_part` | `"total"`, `"tp"`, `"yp"` | Banks split columns into TL (TP) and foreign currency (YP) parts; others are `total` |

### Source

Where a value was read. Enough to find the cell in the filing by hand.

```json
{
  "system": "KAP",
  "document_id": "1651411",
  "company_code": "KATMR",
  "report": { "year": 2026, "quarter": 2, "consolidation": "consolidated" },
  "table": "general_role_310003",
  "row": "general_role_310003-row-5",
  "row_label": "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)",
  "column": "col-order-class-6",
  "period_label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026",
  "shown_value": "189.492.068",
  "scale": "TL",
  "published_at": "2026-08-17T16:05:18Z",
  "url": "https://www.kap.org.tr/tr/Bildirim/1651411"
}
```

`document_id` is a string so other systems' ids fit. `shown_value` is the text in the cell as filed, before scaling (decision 0005). `published_at` is `null` when the filing has no `Gönderim Tarihi`.

### Calculation

How a computed value was obtained. Each step is a `Value` or a formula over earlier steps, so anyone can redo it.

```json
{
  "formula": "gross_profit / revenue",
  "definition": { "id": "gross_margin", "version": "2026-11-01", "url": "/methodology/gross_margin" },
  "steps": [
    { "id": "gross_profit", "label": "Brüt kâr", "value": { "...": "Value with source" } },
    { "id": "revenue", "label": "Hasılat", "value": { "...": "Value with source" } },
    { "id": "result", "label": "Brüt marj", "formula": "gross_profit / revenue", "result": "0.215430" }
  ]
}
```

### Version selection

Every endpoint that returns filed values takes `version`:

| `version=` | Meaning |
|---|---|
| `latest` (default) | The value as in the most recent report that carries it |
| `first` | The value as first reported |
| `report:{document_id}` | The value as in one report |

Order of versions follows `docs/SCHEMA.md` (report period, then publication time, then document id). Most later versions come from IAS 29 restatement; the API reports them as versions, not as errors.

### Lists

Lists use `limit` (default 50, maximum 200) and an opaque `cursor`:

```json
{ "items": [], "next_cursor": "eyJpZCI6...", "total": 42 }
```

`sort` takes a field name, `-` for descending: `sort=-size`.

### Errors

Every error has the same shape and an HTTP status:

```json
{ "error": { "code": "not_found", "message": "Şirket bulunamadı: XYZ", "details": {} } }
```

| Status | `code` |
|---|---|
| 400 | `invalid_request` (`details` names the parameter) |
| 404 | `not_found` |
| 409 | `conflict` (e.g. a download already running) |
| 503 | `not_ready` (start-up, migrations running) |
| 500 | `internal` |

### Reserved

`tier` (response header `Vigil-Tier`) and an `Authorization` header are reserved for the hosted service. The local release ignores them and sends `Vigil-Tier: local`.

## Endpoints

| Method and path | Issue | Returns |
|---|---|---|
| `GET /v1/health` | #200 | `{ "status": "ok" }` while the process runs |
| `GET /v1/ready` | #200 | 200 when Zova and DuckDB are open and migrated, else 503 `not_ready` |
| `GET /v1/meta` | #216 | Loaded quarters, file counts, quality summary, app version, config version |
| `GET /v1/companies?q=&limit=&cursor=` | #217 | Companies; `q` matches codes and title, Turkish-aware |
| `GET /v1/companies/{code}` | #218 | Company and its reports; any of its codes works |
| `GET /v1/companies/{code}/metrics?period=&version=` | #221 | Metrics as Values with calculations |
| `GET /v1/companies/{code}/facts/{row}/versions?period_end=&currency_part=` | #222 | Every version of one line item for one period |
| `GET /v1/reports/{document_id}` | #219 | Report, its versions and check results |
| `GET /v1/reports/{document_id}/statements/{statement}?view=` | #220 | One statement as rows of Values |
| `GET /v1/findings?rule=&template=&quarter=&company=&sort=` | #223 | Findings, without steps |
| `GET /v1/findings/{id}` | #224 | One finding with steps and sources |
| `GET /v1/quality?quarter=` | #225 | Quality summary per quarter and the non-passing files |
| `GET /v1/settings`, `PUT /v1/settings` | #226 | Settings, including the optional LLM provider (Anthropic, Gemini, OpenAI-compatible, Ollama; #253); the API key is write-only |
| `POST /v1/downloads`, `GET /v1/downloads/events` | #227 | Start a download; progress as server-sent events |
| `GET /v1/openapi.json` | #228 | Generated description of these routes |

### Company

```json
{
  "code": "A1CAP",
  "codes": ["A1CAP", "ACP"],
  "title": "<title from the KAP company list, #163>",
  "template": "general",
  "sector": null,
  "member_id": "<KAP mkkMemberOid>",
  "latest_report": { "document_id": "1645514", "year": 2026, "quarter": 2, "quality": "<quality status>" }
}
```

`codes` comes from the ticker group in the file name (`A1CAP-ACP_1645514_2026_2.xls`); `code` is the first one. `title`, `sector` and `member_id` come from the company list (#163) and are `null` until it is loaded.

`/v1/companies/{code}` adds `reports`: every report with `document_id`, `year`, `quarter`, `consolidation`, `published_at`, `quality`, and `corrects` (the document it corrects, or `null`).

### Report

```json
{
  "document_id": "1651411",
  "company_code": "KATMR",
  "year": 2026,
  "quarter": 2,
  "consolidation": "consolidated",
  "template": "general",
  "scale": "TL",
  "published_at": "2026-08-17T16:05:18Z",
  "quality": "pass",
  "checks": [
    {
      "name": "balance_sheet_total",
      "group": "balance",
      "severity": "blocking",
      "status": "pass",
      "left": { "...": "Value" },
      "right": { "...": "Value" },
      "tolerance": "5",
      "known_error": null
    }
  ],
  "url": "https://www.kap.org.tr/tr/Bildirim/1651411"
}
```

`quality` is `pass`, `fail`, `known_error`, `not_checked`, `parse_error` or `no_values` (#19). `known_error` carries the reason when a check fails because of a known filing error (decision 0006).

### Statement

`statement` is `balance_sheet`, `income_statement`, `comprehensive_income`, `cash_flow` or `equity_changes`. `view=cumulative` (default) or `three_month` for income and cash flow; 3-month values come from the 3-month columns as filed, never computed in the browser.

```json
{
  "document_id": "1651411",
  "statement": "income_statement",
  "columns": [{ "id": "col-order-class-6", "period": { "...": "Period" }, "comparative": false }],
  "rows": [
    {
      "row": "general_role_310003-row-3",
      "label": "Hasılat",
      "level": 0,
      "subtotal": false,
      "values": { "col-order-class-6": { "...": "Value" } }
    }
  ]
}
```

### Finding (list item)

```json
{
  "id": "2026-2-KATMR-gross_margin_change",
  "rule": "gross_margin_change",
  "title": "Brüt kâr marjında çeyreklik değişim",
  "company_code": "KATMR",
  "document_id": "1651411",
  "year": 2026,
  "quarter": 2,
  "template": "general",
  "size": { "value": "-2596", "unit": "bps", "status": "ok" },
  "headline": "3 aylık brüt marj %47,50'den %21,54'e geriledi.",
  "config_version": "2026-11-01",
  "created_at": "2026-11-01T12:00:00Z"
}
```

`rule` values: `gross_margin_change` (S1), `profit_cash_divergence` (S2), `restated_comparatives` (S3). `size` is what lists sort by. `headline` states the change; it never says what to do.

### Finding (detail)

The list item plus `calculation` (as in [Calculation](#calculation)), `thresholds` (the values in force, from `config_version`), and `methodology_url`.

## Example: KATMR 2026/2, gross margin change (S1)

`GET /v1/findings/2026-2-KATMR-gross_margin_change`. Every input below is in the golden file `tests/golden/2026_2/KATMR_1651411.csv` (checked by hand, #20); the result is what `detectGrossMarginDeviation` computes for this filing.

```json
{
  "id": "2026-2-KATMR-gross_margin_change",
  "rule": "gross_margin_change",
  "title": "Brüt kâr marjında çeyreklik değişim",
  "company_code": "KATMR",
  "document_id": "1651411",
  "year": 2026,
  "quarter": 2,
  "template": "general",
  "size": { "value": "-2596", "unit": "bps", "status": "ok" },
  "headline": "3 aylık brüt marj %47,50'den %21,54'e geriledi.",
  "config_version": "2026-11-01",
  "created_at": "2026-11-01T12:00:00Z",
  "thresholds": { "min_revenue_try": "100000000", "min_abs_change_bps": 1000 },
  "methodology_url": "/methodology/gross_margin_change",
  "calculation": {
    "formula": "(gross_profit_q / revenue_q - gross_profit_q_prior / revenue_q_prior) * 10000",
    "definition": { "id": "gross_margin_change", "version": "2026-11-01", "url": "/methodology/gross_margin_change" },
    "steps": [
      {
        "id": "gross_profit_q",
        "label": "Brüt kâr, 3 aylık, 2026",
        "value": {
          "value": "189492068",
          "unit": "TRY",
          "status": "ok",
          "period": {
            "start": "2026-04-01",
            "end": "2026-06-30",
            "type": "three_month",
            "label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026",
            "currency_part": "total"
          },
          "source": {
            "system": "KAP",
            "document_id": "1651411",
            "company_code": "KATMR",
            "report": { "year": 2026, "quarter": 2, "consolidation": "consolidated" },
            "table": "general_role_310003",
            "row": "general_role_310003-row-5",
            "row_label": "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)",
            "column": "col-order-class-6",
            "period_label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026",
            "shown_value": "189.492.068",
            "scale": "TL",
            "published_at": "2026-08-17T16:05:18Z",
            "url": "https://www.kap.org.tr/tr/Bildirim/1651411"
          }
        }
      },
      {
        "id": "revenue_q",
        "label": "Hasılat, 3 aylık, 2026",
        "value": {
          "value": "879599263",
          "unit": "TRY",
          "status": "ok",
          "period": { "start": "2026-04-01", "end": "2026-06-30", "type": "three_month", "label": "Cari Dönem 3 Aylık 01.04.2026 - 30.06.2026", "currency_part": "total" },
          "source": { "system": "KAP", "document_id": "1651411", "table": "general_role_310003", "row": "general_role_310003-row-3", "row_label": "Hasılat", "column": "col-order-class-6", "shown_value": "879.599.263", "scale": "TL", "url": "https://www.kap.org.tr/tr/Bildirim/1651411" }
        }
      },
      {
        "id": "gross_profit_q_prior",
        "label": "Brüt kâr, 3 aylık, 2025 (yeniden düzenlenmiş)",
        "value": {
          "value": "330145727",
          "unit": "TRY",
          "status": "ok",
          "period": { "start": "2025-04-01", "end": "2025-06-30", "type": "three_month", "label": "Önceki Dönem 3 Aylık 01.04.2025 - 30.06.2025", "currency_part": "total" },
          "source": { "system": "KAP", "document_id": "1651411", "table": "general_role_310003", "row": "general_role_310003-row-5", "row_label": "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)", "column": "col-order-class-7", "shown_value": "330.145.727", "scale": "TL", "url": "https://www.kap.org.tr/tr/Bildirim/1651411" }
        }
      },
      {
        "id": "revenue_q_prior",
        "label": "Hasılat, 3 aylık, 2025 (yeniden düzenlenmiş)",
        "value": {
          "value": "694991758",
          "unit": "TRY",
          "status": "ok",
          "period": { "start": "2025-04-01", "end": "2025-06-30", "type": "three_month", "label": "Önceki Dönem 3 Aylık 01.04.2025 - 30.06.2025", "currency_part": "total" },
          "source": { "system": "KAP", "document_id": "1651411", "table": "general_role_310003", "row": "general_role_310003-row-3", "row_label": "Hasılat", "column": "col-order-class-7", "shown_value": "694.991.758", "scale": "TL", "url": "https://www.kap.org.tr/tr/Bildirim/1651411" }
        }
      },
      { "id": "margin_q", "label": "Brüt marj, 2026 Ç2", "formula": "gross_profit_q / revenue_q", "result": "0.215430" },
      { "id": "margin_q_prior", "label": "Brüt marj, 2025 Ç2", "formula": "gross_profit_q_prior / revenue_q_prior", "result": "0.475035" },
      { "id": "change_bps", "label": "Değişim (baz puan)", "formula": "(margin_q - margin_q_prior) * 10000", "result": "-2596" }
    ]
  }
}
```

The three shorter sources omit fields that repeat the first one (`company_code`, `report`, `period_label`, `published_at`) only to keep this page readable; the API always sends every field.

Check by hand: 189,492,068 / 879,599,263 = 0.215430; 330,145,727 / 694,991,758 = 0.475035; (0.215430 − 0.475035) × 10,000 = −2,596 bps. The prior-year figures are the 2025 quarter as restated in the 2026/2 report (IAS 29); the 2025/2 report filed 1,085,459,841 TL cumulative revenue for the half year, which the version endpoint (#222) returns as version 1.

The thresholds shown are the prototype's (`minRevenueTl`, `minAbsDeltaBps` in `packages/core/src/signals.ts`); the agreed values come from decision #56.

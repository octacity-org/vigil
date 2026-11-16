/**
 * Compute a report's metrics after it is loaded (#209, processor #166) and store them with `writeMetrics` (#184): each
 * metric as a value or the reason it cannot be computed (#65), with every input and the cell it was read from (#72).
 *
 * The metrics are those defined so far (#60 EBITDA, #61 gross margin, #62 cash quality, the balance sheet ratios and
 * net debt of decision 0012, TTM EBITDA of decision 0014). They are read from the report's own facts in DuckDB, so a
 * metric always matches the stored report:
 *
 * | Metric | Period | Rows (general template) |
 * |---|---|---|
 * | `current_ratio`, `quick_ratio`, `cash_ratio` | point in time | balance sheet 55, 40, 4 over 191 |
 * | `net_debt`, `net_debt_to_equity` | point in time | 132 + 143 + 193 − 4; over 296 |
 * | `liabilities_to_assets` | point in time | 242 / 129 (242 = 129 − 296 when not reported) |
 * | `gross_margin` | cumulative, 3 months, 3 months a year earlier | income statement 31 / 3 |
 * | `gross_margin_change` | 3 months, in basis points | the 3-month margin against the same quarter a year earlier |
 * | `ebitda_a`, `ebitda_b`, `ebitda_b_minus_a` | cumulative | 31 + 32 + 33 + 34 + cash flow 7; 38 + 7 |
 * | `fcf`, `cfo_to_ebitda`, `capex_to_d_and_a` | cumulative | cash flow 2 + 133; 2 / EBITDA A; −133 / 7 |
 * | `accrual_ratio` | cumulative | (59 − cash flow 2) / average of 129 now and at the previous year end |
 * | `ebitda_a_ttm`, `net_debt_to_ebitda` | TTM | EBITDA A with the previous year-end report, CPI-adjusted (#93) |
 *
 * **Affected periods.** The TTM metrics of a report in quarters 1 to 3 use the company's previous year-end report (same
 * consolidation; the latest disclosure, so a correction is used once it is loaded, #204). Loading a year-end report, a
 * correction of one included, therefore also recomputes the next year's reports of quarters 1 to 3.
 *
 * Templates other than the general and holding ones (banks, insurance, finance) have none of these rows: their metrics
 * are stored as "not applicable".
 */
import {
  accrualRatio,
  type CpiSeries,
  capexToDepreciation,
  cashRatio,
  cfoToEbitda,
  collect,
  currentRatio,
  ebitdaA,
  ebitdaB,
  freeCashFlow,
  grossMargin,
  INCOME_STATEMENT_ROLES,
  type Input,
  type IsoDate,
  liabilitiesToAssets,
  marginChangePoints,
  netDebtToEbitda,
  netDebtToEquity,
  notComputable,
  notReported,
  ok,
  quickRatio,
  type Result,
  ttmFlow,
} from "@vigil/core";
import { CPI_FILE, readCpiFile } from "./cpi.ts";
import { type Database, rows } from "./db.ts";
import {
  type FactRef,
  type MetricInputValue,
  type MetricUnit,
  type MetricValue,
  type PeriodType,
  writeMetrics,
} from "./metrics-store.ts";

const BALANCE_SHEET = "210015";
const CASH_FLOW = "520003";
const CURRENT = "col-order-class-4";
const PRIOR = "col-order-class-5";

interface Cell {
  value: bigint;
  ref: FactRef;
  period_start: string | null;
  period_end: string | null;
  period_type: string;
}

/** A loaded report, as metrics need it: its facts by role, row number and column. */
export interface ReportCells {
  disclosure_id: number;
  company_code: string;
  year: number;
  quarter: number;
  consolidation_type: string;
  template_family: string;
  cells: Map<string, Cell>;
}

const key = (role: string, row: number, column: string) => `${role}|${row}|${column}`;

/** Read a report from DuckDB; null when it is not loaded. */
export async function readReportCells(db: Database, disclosureId: number): Promise<ReportCells | null> {
  const id = BigInt(disclosureId);
  const [r] = await rows(
    db,
    "SELECT company_code, year, quarter, consolidation_type, template_family FROM reports WHERE disclosure_id = $1",
    [id],
  );
  if (r === undefined) return null;
  const facts = await rows(
    db,
    `SELECT role_code, row_id, column_class, period_type, strftime(period_start, '%Y-%m-%d') AS period_start,
       strftime(period_end, '%Y-%m-%d') AS period_end, normalized_value_tl::VARCHAR AS value
     FROM facts WHERE disclosure_id = $1`,
    [id],
  );
  const cells = new Map<string, Cell>();
  for (const f of facts) {
    const row = Number(String(f.row_id).split("-").pop());
    cells.set(key(String(f.role_code), row, String(f.column_class)), {
      value: BigInt(String(f.value)),
      ref: { disclosure_id: disclosureId, row_id: String(f.row_id), column_class: String(f.column_class) },
      period_start: f.period_start === null ? null : String(f.period_start),
      period_end: f.period_end === null ? null : String(f.period_end),
      period_type: String(f.period_type),
    });
  }
  return {
    disclosure_id: disclosureId,
    company_code: String(r.company_code),
    year: Number(r.year),
    quarter: Number(r.quarter),
    consolidation_type: String(r.consolidation_type),
    template_family: String(r.template_family),
    cells,
  };
}

/** An input read from one cell: its value (or "not reported") and where it was read. */
interface Read {
  code: string;
  result: Result<bigint>;
  source: FactRef | null;
}

export interface MetricContext {
  /** The company's previous year-end report, for the TTM metrics; null when it is not loaded. */
  priorYearEnd: ReportCells | null;
  cpi: CpiSeries;
  /**
   * The balance sheet passed the reconciliation checks: then a borrowing row left empty counts as no borrowings
   * (decision 0012); otherwise net debt is not computable without it.
   */
  balanceSheetComplete: boolean;
}

const tl = (r: Read): MetricInputValue => ({ code: r.code, result: r.result, unit: "TRY", source: r.source });
const derived = (code: string, result: Result<bigint | number>, unit: MetricUnit): MetricInputValue => ({
  code,
  result,
  unit,
  source: null,
});

/** The value of a Result for use as an input of another metric. */
const asInput = <T>(r: Result<T>): Input<T> => r;

/** Compute every metric of one report. */
export function computeReportMetrics(report: ReportCells, context: MetricContext): MetricValue[] {
  const { cells } = report;
  const isRole = INCOME_STATEMENT_ROLES.find((role) => [...cells.keys()].some((k) => k.startsWith(`${role}|`)));
  const hasBalanceSheet = [...cells.keys()].some((k) => k.startsWith(`${BALANCE_SHEET}|`));
  const hasCashFlow = [...cells.keys()].some((k) => k.startsWith(`${CASH_FLOW}|`));
  const read = (role: string | undefined, row: number, column: string, code: string): Read => {
    const c = role === undefined ? undefined : cells.get(key(role, row, column));
    return { code, result: c === undefined ? notReported() : ok(c.value), source: c?.ref ?? null };
  };

  // The report's periods, from its own columns.
  const anyCell = (role: string | undefined, column: string) =>
    [...cells.entries()].find(([k]) => role !== undefined && k.startsWith(`${role}|`) && k.endsWith(`|${column}`))?.[1];
  const balanceEnd = anyCell(BALANCE_SHEET, CURRENT)?.period_end ?? null;
  const flowColumn = anyCell(isRole, CURRENT) ?? anyCell(CASH_FLOW, CURRENT);
  const flowStart = flowColumn?.period_start ?? null;
  // A report without these statements (banks, insurance) still has a period end, from any current column.
  const anyEnd =
    [...cells.entries()].find(([k, c]) => k.endsWith(`|${CURRENT}`) && c.period_end !== null)?.[1].period_end ?? null;
  const flowEnd = flowColumn?.period_end ?? balanceEnd ?? anyEnd;

  const out: MetricValue[] = [];
  const add = (
    metric_code: string,
    period_type: PeriodType,
    period: { start: string | null; end: string | null },
    result: Result<bigint | number>,
    unit: MetricUnit,
    formula: string,
    inputs: MetricInputValue[],
  ) => {
    if (period.end === null) return; // the report has no column for this period at all
    out.push({
      metric_code,
      period_type,
      period_start: period.start,
      period_end: period.end,
      result,
      unit,
      formula,
      inputs,
    });
  };
  const na = (what: string) =>
    notComputable("not_applicable", `${what} ${report.template_family} şablonunda tanımlı değil.`);

  // Balance sheet: point in time.
  const pit = { start: null, end: balanceEnd ?? flowEnd };
  const bs = (row: number, code: string, column = CURRENT) =>
    read(hasBalanceSheet ? BALANCE_SHEET : undefined, row, column, code);
  const currentAssets = bs(55, "current_assets");
  const currentLiabilities = bs(191, "current_liabilities");
  const inventories = bs(40, "inventories");
  const cash = bs(4, "cash");
  const equity = bs(296, "equity");
  const totalAssets = bs(129, "total_assets");
  const totalLiabilities = bs(242, "total_liabilities");
  const borrowings = [
    bs(132, "financial_debt:short_term"),
    bs(143, "financial_debt:current_portion"),
    bs(193, "financial_debt:long_term"),
  ];

  let netDebt: Result<bigint>;
  if (!hasBalanceSheet) {
    netDebt = na("Net borç");
    for (const [code, what] of [
      ["current_ratio", "Cari oran"],
      ["quick_ratio", "Likidite oranı"],
      ["cash_ratio", "Nakit oranı"],
      ["net_debt", "Net borç"],
      ["net_debt_to_equity", "Net borç / özkaynak"],
      ["liabilities_to_assets", "Yükümlülük / varlık"],
    ] as const) {
      add(code, "point_in_time", pit, na(what), code === "net_debt" ? "TRY" : "ratio", "", []);
    }
  } else {
    add(
      "current_ratio",
      "point_in_time",
      pit,
      currentRatio(currentAssets.result, currentLiabilities.result),
      "ratio",
      "current_assets / current_liabilities",
      [tl(currentAssets), tl(currentLiabilities)],
    );
    add(
      "quick_ratio",
      "point_in_time",
      pit,
      quickRatio(currentAssets.result, inventories.result, currentLiabilities.result),
      "ratio",
      "(current_assets - inventories) / current_liabilities",
      [tl(currentAssets), tl(inventories), tl(currentLiabilities)],
    );
    add(
      "cash_ratio",
      "point_in_time",
      pit,
      cashRatio(cash.result, currentLiabilities.result),
      "ratio",
      "cash / current_liabilities",
      [tl(cash), tl(currentLiabilities)],
    );

    // Decision 0012: an empty borrowing row is no borrowings only in a balance sheet that reconciles.
    const missing = borrowings.filter((b) => b.result.status !== "ok");
    if (cash.result.status !== "ok") {
      netDebt = notComputable("missing_input", "Net borç hesaplanamaz: nakit ve nakit benzerleri raporda yok.", [
        "cash",
      ]);
    } else if (missing.length > 0 && !context.balanceSheetComplete) {
      netDebt = notComputable(
        "missing_input",
        "Net borç hesaplanamaz: borçlanma satırı boş ve bilanço tutarlılık kontrollerini geçmedi.",
        missing.map((b) => b.code),
      );
    } else {
      const debt = borrowings.reduce((s, b) => s + (b.result.status === "ok" ? b.result.value : 0n), 0n);
      netDebt = ok(debt - cash.result.value);
    }
    add(
      "net_debt",
      "point_in_time",
      pit,
      netDebt,
      "TRY",
      "financial_debt:short_term + financial_debt:current_portion + financial_debt:long_term - cash",
      [...borrowings.map(tl), tl(cash)],
    );
    add(
      "net_debt_to_equity",
      "point_in_time",
      pit,
      netDebtToEquity(asInput(netDebt), equity.result),
      "ratio",
      "net_debt / equity",
      [derived("net_debt", netDebt, "TRY"), tl(equity)],
    );

    if (totalLiabilities.result.status === "ok") {
      add(
        "liabilities_to_assets",
        "point_in_time",
        pit,
        liabilitiesToAssets(totalLiabilities.result, totalAssets.result),
        "ratio",
        "total_liabilities / total_assets",
        [tl(totalLiabilities), tl(totalAssets)],
      );
    } else {
      const c = collect({ total_assets: totalAssets.result, equity: equity.result });
      const liabilities: Result<bigint> = "values" in c ? ok(c.values.total_assets - c.values.equity) : c;
      add(
        "liabilities_to_assets",
        "point_in_time",
        pit,
        liabilitiesToAssets(asInput(liabilities), totalAssets.result),
        "ratio",
        "(total_assets - equity) / total_assets",
        [tl(totalAssets), tl(equity)],
      );
    }
  }

  // Income statement and cash flow: cumulative.
  const cum = { start: flowStart, end: flowEnd };
  const is = (row: number, code: string, column = CURRENT) => read(isRole, row, column, code);
  const cf = (row: number, code: string, column = CURRENT) =>
    read(hasCashFlow ? CASH_FLOW : undefined, row, column, code);

  const ebitdaInputs = (column: string) => ({
    gross_profit: is(31, "gross_profit", column),
    g_and_a: is(32, "g_and_a", column),
    selling_expenses: is(33, "selling_expenses", column),
    r_and_d: is(34, "r_and_d", column),
    d_and_a: cf(7, "d_and_a", column),
  });
  const ei = ebitdaInputs(CURRENT);
  const operatingProfit = is(38, "operating_profit");
  const cfo = cf(2, "cfo");
  const capex = cf(133, "capex");
  const netProfit = is(59, "net_profit");
  const generalIs = isRole !== undefined && report.template_family === "general";

  const ebitda = (i: ReturnType<typeof ebitdaInputs>) =>
    ebitdaA({
      gross_profit: i.gross_profit.result,
      g_and_a: i.g_and_a.result,
      selling_expenses: i.selling_expenses.result,
      r_and_d: i.r_and_d.result,
      d_and_a: i.d_and_a.result,
    });
  const ebitdaAValue: Result<bigint> = generalIs && hasCashFlow ? ebitda(ei) : na("FAVÖK");
  const ebitdaBValue: Result<bigint> =
    isRole !== undefined && hasCashFlow
      ? ebitdaB({ operating_profit: operatingProfit.result, d_and_a: ei.d_and_a.result })
      : na("FAVÖK");
  const ab = collect({ ebitda_b: ebitdaBValue, ebitda_a: ebitdaAValue });
  const ebitdaInputList = [ei.gross_profit, ei.g_and_a, ei.selling_expenses, ei.r_and_d, ei.d_and_a].map(tl);

  add(
    "gross_margin",
    "cumulative",
    cum,
    generalIs ? grossMargin(is(31, "gross_profit").result, is(3, "revenue").result) : na("Brüt marj"),
    "ratio",
    "gross_profit / revenue",
    [tl(is(31, "gross_profit")), tl(is(3, "revenue"))],
  );
  add(
    "ebitda_a",
    "cumulative",
    cum,
    ebitdaAValue,
    "TRY",
    "gross_profit + g_and_a + selling_expenses + r_and_d + d_and_a",
    ebitdaInputList,
  );
  add("ebitda_b", "cumulative", cum, ebitdaBValue, "TRY", "operating_profit + d_and_a", [
    tl(operatingProfit),
    tl(ei.d_and_a),
  ]);
  add(
    "ebitda_b_minus_a",
    "cumulative",
    cum,
    "values" in ab ? ok(ab.values.ebitda_b - ab.values.ebitda_a) : isRole === undefined ? na("FAVÖK") : ab,
    "TRY",
    "ebitda_b - ebitda_a",
    [derived("ebitda_b", ebitdaBValue, "TRY"), derived("ebitda_a", ebitdaAValue, "TRY")],
  );
  add(
    "fcf",
    "cumulative",
    cum,
    hasCashFlow ? freeCashFlow(cfo.result, capex.result) : na("Serbest nakit akışı"),
    "TRY",
    "cfo + capex",
    [tl(cfo), tl(capex)],
  );
  add(
    "cfo_to_ebitda",
    "cumulative",
    cum,
    hasCashFlow ? cfoToEbitda(cfo.result, asInput(ebitdaAValue)) : na("FNA / FAVÖK"),
    "ratio",
    "cfo / ebitda_a",
    [tl(cfo), derived("ebitda_a", ebitdaAValue, "TRY")],
  );
  add(
    "capex_to_d_and_a",
    "cumulative",
    cum,
    hasCashFlow ? capexToDepreciation(capex.result, ei.d_and_a.result) : na("Yatırım / amortisman"),
    "ratio",
    "-capex / d_and_a",
    [tl(capex), tl(ei.d_and_a)],
  );
  const assetsPrior = bs(129, "total_assets:prior_year_end", PRIOR);
  add(
    "accrual_ratio",
    "cumulative",
    cum,
    isRole !== undefined && hasCashFlow && hasBalanceSheet
      ? accrualRatio(netProfit.result, cfo.result, totalAssets.result, assetsPrior.result)
      : na("Tahakkuk oranı"),
    "ratio",
    "(net_profit - cfo) / ((total_assets + total_assets:prior_year_end) / 2)",
    [tl(netProfit), tl(cfo), tl(totalAssets), tl(assetsPrior)],
  );

  // Three-month gross margin (#61): the report's own 3-month columns for the quarter and a year earlier.
  if (generalIs) {
    const yearEarlier = (d: string | null) => (d === null ? null : `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`);
    const quarterColumn = (end: string | null) =>
      [...cells.entries()]
        .filter(([k, c]) => k.startsWith(`${isRole}|3|`) && c.period_type === "Q_STANDALONE" && c.period_end === end)
        .map(([, c]) => c)
        .sort((a, b) => a.ref.column_class.localeCompare(b.ref.column_class))[0];
    const margin = (end: string | null, suffix: string) => {
      const col = quarterColumn(end);
      const gp = col === undefined ? null : is(31, `gross_profit:three_month${suffix}`, col.ref.column_class);
      const rev = col === undefined ? null : is(3, `revenue:three_month${suffix}`, col.ref.column_class);
      const result: Result<number> =
        gp === null || rev === null
          ? notComputable(
              "period_mismatch",
              "Raporda bu dönemin 3 aylık kolonu yok; önceki rapordan türetilmesi gerekir.",
              ["gross_profit:three_month", "revenue:three_month"],
            )
          : grossMargin(gp.result, rev.result);
      return { col, result, inputs: gp === null || rev === null ? [] : [tl(gp), tl(rev)] };
    };
    const now3 = margin(flowEnd, "");
    const before3 = margin(yearEarlier(flowEnd), ":prior_year");
    const p = (m: typeof now3, end: string | null) => ({
      start: m.col?.period_start ?? null,
      end: m.col?.period_end ?? end,
    });
    add(
      "gross_margin",
      "three_month",
      p(now3, flowEnd),
      now3.result,
      "ratio",
      "gross_profit:three_month / revenue:three_month",
      now3.inputs,
    );
    add(
      "gross_margin",
      "three_month",
      p(before3, yearEarlier(flowEnd)),
      before3.result,
      "ratio",
      "gross_profit:three_month / revenue:three_month (a year earlier)",
      before3.inputs,
    );
    const points = marginChangePoints(now3.result, before3.result);
    add(
      "gross_margin_change",
      "three_month",
      p(now3, flowEnd),
      points.status === "ok" ? ok(points.value * 100) : points,
      "bps",
      "(gross_margin - gross_margin:prior_year) × 10000",
      [derived("gross_margin", now3.result, "ratio"), derived("gross_margin:prior_year", before3.result, "ratio")],
    );
  }

  // TTM (decision 0014): EBITDA A over the last twelve months, with the previous year-end report.
  const ttmPeriod = { start: null, end: flowEnd };
  if (generalIs && hasCashFlow && flowStart !== null && flowEnd !== null) {
    const prior = context.priorYearEnd;
    const priorYtd = ebitda(ebitdaInputs(PRIOR));
    let priorFull: Result<bigint> = notReported();
    let priorEnd: IsoDate | null = null;
    if (prior !== null) {
      const priorCells = (role: string, row: number) => prior.cells.get(key(role, row, CURRENT));
      const pRole = INCOME_STATEMENT_ROLES.find((role) =>
        [...prior.cells.keys()].some((k) => k.startsWith(`${role}|`)),
      );
      const v = (role: string | undefined, row: number): Result<bigint> => {
        const c = role === undefined ? undefined : priorCells(role, row);
        return c === undefined ? notReported() : ok(c.value);
      };
      priorFull = ebitdaA({
        gross_profit: v(pRole, 31),
        g_and_a: v(pRole, 32),
        selling_expenses: v(pRole, 33),
        r_and_d: v(pRole, 34),
        d_and_a: v(CASH_FLOW, 7),
      });
      priorEnd =
        (pRole === undefined ? undefined : priorCells(pRole, 3))?.period_end ??
        [...prior.cells.entries()].find(([k]) => k.endsWith(`|${CURRENT}`))?.[1].period_end ??
        null;
    }
    const ttm = ttmFlow({
      name: "ebitda_a",
      current: ebitdaAValue,
      period: { start: flowStart as IsoDate, end: flowEnd as IsoDate },
      priorYearToDate: priorYtd,
      priorFullYear: priorFull,
      priorFullYearEnd: priorEnd,
      cpi: context.cpi,
    });
    const ttmValue: Result<bigint> = ttm.status === "ok" ? ok(ttm.value.value) : ttm;
    const source =
      prior === null ? "no previous year-end report" : `previous year end: disclosure ${prior.disclosure_id}`;
    add(
      "ebitda_a_ttm",
      "ttm",
      ttmPeriod,
      ttmValue,
      "TRY",
      ttm.status === "ok" && ttm.value.from_full_year_report
        ? "ebitda_a (the report covers a full year)"
        : `ebitda_a + ebitda_a:prior_full_year × CPI(period end) / CPI(previous year end) - ebitda_a:prior_year_to_date (${source})`,
      [
        derived("ebitda_a", ebitdaAValue, "TRY"),
        derived("ebitda_a:prior_full_year", priorFull, "TRY"),
        derived("ebitda_a:prior_year_to_date", priorYtd, "TRY"),
      ],
    );
    add(
      "net_debt_to_ebitda",
      "ttm",
      ttmPeriod,
      netDebtToEbitda(asInput(netDebt), asInput(ttmValue)),
      "ratio",
      "net_debt / ebitda_a_ttm",
      [derived("net_debt", netDebt, "TRY"), derived("ebitda_a_ttm", ttmValue, "TRY")],
    );
  } else {
    add("ebitda_a_ttm", "ttm", ttmPeriod, na("Son 12 ay FAVÖK"), "TRY", "", []);
    add("net_debt_to_ebitda", "ttm", ttmPeriod, na("Net borç / FAVÖK"), "ratio", "", []);
  }
  return out;
}

/** The company's latest loaded year-end report before `report`'s year, with the same consolidation. */
async function priorYearEnd(db: Database, report: ReportCells): Promise<ReportCells | null> {
  const [r] = await rows(
    db,
    `SELECT disclosure_id FROM reports
     WHERE company_code = $1 AND consolidation_type = $2 AND year = $3 AND quarter = 4
     ORDER BY disclosure_id DESC LIMIT 1`,
    [report.company_code, report.consolidation_type, report.year - 1],
  );
  return r === undefined ? null : readReportCells(db, Number(r.disclosure_id));
}

async function balanceSheetComplete(db: Database, disclosureId: number): Promise<boolean> {
  const [r] = await rows(
    db,
    `SELECT count(*) AS n FROM check_results
     WHERE disclosure_id = $1 AND check_group IN ('reconciliation', 'balance_sheet') AND status = 'fail'`,
    [BigInt(disclosureId)],
  );
  return Number(r?.n) === 0;
}

let shippedCpi: CpiSeries | null = null;

export interface RefreshOptions {
  /** The CPI series; defaults to the one that ships with Vigil. */
  cpi?: CpiSeries;
  computedAt?: Date;
}

/** Compute and store the metrics of one loaded report. Returns false when the report is not loaded. */
export async function computeAndStore(db: Database, disclosureId: number, options: RefreshOptions = {}) {
  const report = await readReportCells(db, disclosureId);
  if (report === null) return false;
  shippedCpi ??= options.cpi === undefined ? readCpiFile(CPI_FILE) : null;
  const metrics = computeReportMetrics(report, {
    priorYearEnd: report.quarter === 4 ? null : await priorYearEnd(db, report),
    cpi: options.cpi ?? (shippedCpi as CpiSeries),
    balanceSheetComplete: await balanceSheetComplete(db, disclosureId),
  });
  await writeMetrics(db, report, metrics, { computedAt: options.computedAt });
  return true;
}

/** The reports whose TTM metrics use a year-end report of this company, year and consolidation. */
async function dependents(
  db: Database,
  period: { company_code: string; consolidation_type: string; year: number; quarter: number },
): Promise<number[]> {
  if (period.quarter !== 4) return [];
  return (
    await rows(
      db,
      `SELECT disclosure_id FROM reports
       WHERE company_code = $1 AND consolidation_type = $2 AND year = $3 AND quarter < 4 ORDER BY disclosure_id`,
      [period.company_code, period.consolidation_type, period.year + 1],
    )
  ).map((r) => Number(r.disclosure_id));
}

export async function periodOf(db: Database, disclosureId: number) {
  const [r] = await rows(
    db,
    "SELECT company_code, consolidation_type, year, quarter FROM reports WHERE disclosure_id = $1",
    [BigInt(disclosureId)],
  );
  return r === undefined
    ? null
    : {
        company_code: String(r.company_code),
        consolidation_type: String(r.consolidation_type),
        year: Number(r.year),
        quarter: Number(r.quarter),
      };
}

/**
 * Refresh the metrics affected by a report that was loaded or removed: the report itself and, for a year-end report,
 * the next year's reports of quarters 1 to 3, whose TTM metrics use it. `removed` gives the period of a report that is
 * no longer loaded. Returns the reports whose metrics were written.
 */
export async function refreshMetrics(
  db: Database,
  disclosureId: number,
  options: RefreshOptions & {
    removed?: { company_code: string; consolidation_type: string; year: number; quarter: number } | null;
  } = {},
): Promise<number[]> {
  const out: number[] = [];
  if (await computeAndStore(db, disclosureId, options)) out.push(disclosureId);
  const period = options.removed ?? (await periodOf(db, disclosureId));
  if (period === null) return out;
  for (const id of await dependents(db, period)) {
    if (id !== disclosureId && (await computeAndStore(db, id, options))) out.push(id);
  }
  return out;
}

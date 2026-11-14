/**
 * Balance sheet ratios and EBITDA (docs/VIGIL.md, docs/DATA_CONTRACT.md, decision 0011). Every metric returns a `Result` (#65): a value, or
 * "not computable" with the reason and the inputs that would make it computable. A missing input, a cell the
 * company left empty or a zero denominator is never turned into 0, NaN or a fallback value.
 *
 * Input names in reasons are glossary codes (`docs/glossary.md`): `financial_debt` for borrowings, `cash` for cash
 * and cash equivalents.
 */
import { collect, type Input, ok, type Result, zeroDenominator } from "./result.ts";

export type Amount = number | bigint;

const isZero = (v: Amount) => (typeof v === "bigint" ? v === 0n : v === 0);

/** a - b, exact when both are integers. */
function minus(a: Amount, b: Amount): Amount {
  return typeof a === "bigint" && typeof b === "bigint" ? a - b : Number(a) - Number(b);
}

/** numerator / denominator; the names are glossary codes used in the reason. */
function ratio(
  numeratorCode: string,
  numerator: Input<Amount>,
  denominatorCode: string,
  denominator: Input<Amount>,
): Result<number> {
  const c = collect({ [numeratorCode]: numerator, [denominatorCode]: denominator } as Record<string, Input<Amount>>);
  if (!("values" in c)) return c;
  const d = c.values[denominatorCode] as Amount;
  if (isZero(d)) return zeroDenominator(denominatorCode);
  return ok(Number(c.values[numeratorCode]) / Number(d));
}

/** Cari oran: dönen varlıklar / kısa vadeli yükümlülükler. */
export function currentRatio(currentAssets: Input<Amount>, currentLiabilities: Input<Amount>): Result<number> {
  return ratio("current_assets", currentAssets, "current_liabilities", currentLiabilities);
}

/** Likidite oranı: (dönen varlıklar - stoklar) / kısa vadeli yükümlülükler. */
export function quickRatio(
  currentAssets: Input<Amount>,
  inventories: Input<Amount>,
  currentLiabilities: Input<Amount>,
): Result<number> {
  const c = collect({ current_assets: currentAssets, inventories, current_liabilities: currentLiabilities });
  if (!("values" in c)) return c;
  const { current_assets, inventories: inv, current_liabilities } = c.values;
  return ratio("current_assets", minus(current_assets, inv), "current_liabilities", current_liabilities);
}

/** Nakit oranı: nakit ve nakit benzerleri / kısa vadeli yükümlülükler. */
export function cashRatio(cash: Input<Amount>, currentLiabilities: Input<Amount>): Result<number> {
  return ratio("cash", cash, "current_liabilities", currentLiabilities);
}

/**
 * Net borç: finansal borçlar - nakit ve nakit benzerleri (financial rule 5, decision 0012). Exact (bigint) when
 * both inputs are bigint.
 */
export function netDebt(borrowings: Input<Amount>, cash: Input<Amount>): Result<Amount> {
  const c = collect({ financial_debt: borrowings, cash });
  if (!("values" in c)) return c;
  return ok(minus(c.values.financial_debt, c.values.cash));
}

/** Net borç / özkaynak. */
export function netDebtToEquity(netDebtValue: Input<Amount>, equity: Input<Amount>): Result<number> {
  return ratio("net_debt", netDebtValue, "equity", equity);
}

/** Yükümlülük / varlık: toplam yükümlülükler / toplam varlıklar. */
export function liabilitiesToAssets(totalLiabilities: Input<Amount>, totalAssets: Input<Amount>): Result<number> {
  return ratio("total_liabilities", totalLiabilities, "total_assets", totalAssets);
}

export interface EbitdaInputs {
  /** `BRÜT KAR (ZARAR)`, income statement row 31. */
  gross_profit?: Input<bigint>;
  /** `Genel Yönetim Giderleri`, row 32 (negative). */
  g_and_a?: Input<bigint>;
  /** `Pazarlama Giderleri`, row 33 (negative). */
  selling_expenses?: Input<bigint>;
  /** `Araştırma ve Geliştirme Giderleri`, row 34 (negative). */
  r_and_d?: Input<bigint>;
  /** `ESAS FAALİYET KARI (ZARARI)`, row 38. */
  operating_profit?: Input<bigint>;
  /** Depreciation and amortisation, cash flow statement row 7 (cumulative only). */
  d_and_a?: Input<bigint>;
}

/**
 * EBITDA definition A (decision 0011, the default): gross profit + general and administrative + selling + R&D
 * expenses + D&A. Expenses are filed as negative numbers, so they are added. Missing D&A makes it not computable;
 * it is never computed with zero D&A.
 */
export function ebitdaA(i: EbitdaInputs): Result<bigint> {
  const c = collect({
    gross_profit: i.gross_profit,
    g_and_a: i.g_and_a,
    selling_expenses: i.selling_expenses,
    r_and_d: i.r_and_d,
    d_and_a: i.d_and_a,
  });
  if (!("values" in c)) return c;
  const v = c.values;
  return ok(v.gross_profit + v.g_and_a + v.selling_expenses + v.r_and_d + v.d_and_a);
}

/** EBITDA definition B (decision 0011, shown next to A): operating profit + D&A. */
export function ebitdaB(i: EbitdaInputs): Result<bigint> {
  const c = collect({ operating_profit: i.operating_profit, d_and_a: i.d_and_a });
  if (!("values" in c)) return c;
  return ok(c.values.operating_profit + c.values.d_and_a);
}

export interface Ebitda {
  a: Result<bigint>;
  b: Result<bigint>;
  /** B − A: other operating income and expenses (decision 0011 shows it wherever EBITDA is shown). */
  b_minus_a: Result<bigint>;
}

/** Both EBITDA definitions and their difference. */
export function ebitda(i: EbitdaInputs): Ebitda {
  const a = ebitdaA(i);
  const b = ebitdaB(i);
  const c = collect({ ebitda_b: b, ebitda_a: a });
  return { a, b, b_minus_a: "values" in c ? ok(c.values.ebitda_b - c.values.ebitda_a) : c };
}

/**
 * Net borç / FAVÖK: net debt over trailing-twelve-month EBITDA A (decisions 0011, 0014; TTM from `ttmFlow`, #93).
 * A year-to-date EBITDA must not be passed here.
 */
export function netDebtToEbitda(netDebtValue: Input<Amount>, ttmEbitdaA: Input<Amount>): Result<number> {
  return ratio("net_debt", netDebtValue, "ebitda_a_ttm", ttmEbitdaA);
}

/**
 * Serbest nakit akışı: operating cash flow (cash flow row 2) − capital expenditure. Capex is cash flow row 133,
 * filed as a negative outflow, so it is added.
 */
export function freeCashFlow(cfo: Input<bigint>, capex: Input<bigint>): Result<bigint> {
  const c = collect({ cfo, capex });
  if (!("values" in c)) return c;
  return ok(c.values.cfo + c.values.capex);
}

/** Faaliyet nakit akışı / FAVÖK A, for flows of the same period. */
export function cfoToEbitda(cfo: Input<bigint>, ebitdaAValue: Input<bigint>): Result<number> {
  return ratio("cfo", cfo, "ebitda_a", ebitdaAValue);
}

/** Yatırım harcaması / amortisman: capex as a positive amount (−row 133) over D&A (row 7). */
export function capexToDepreciation(capex: Input<bigint>, dAndA: Input<bigint>): Result<number> {
  const c = collect({ capex, d_and_a: dAndA });
  if (!("values" in c)) return c;
  return ratio("capex", -c.values.capex, "d_and_a", c.values.d_and_a);
}

/**
 * Tahakkuk oranı: (net profit − operating cash flow) / average total assets, where the average is (period end +
 * previous year end) / 2, both from the same report (decision 0014). Flows of any length can be passed; S2 uses
 * TTM flows (decision 0018).
 */
export function accrualRatio(
  netProfit: Input<bigint>,
  cfo: Input<bigint>,
  totalAssets: Input<bigint>,
  totalAssetsPriorYearEnd: Input<bigint>,
): Result<number> {
  const c = collect({
    net_profit: netProfit,
    cfo,
    total_assets: totalAssets,
    "total_assets:prior_year_end": totalAssetsPriorYearEnd,
  });
  if (!("values" in c)) return c;
  const v = c.values;
  const sum = v.total_assets + v["total_assets:prior_year_end"];
  if (sum === 0n) return zeroDenominator("total_assets");
  return ok((Number(v.net_profit - v.cfo) * 2) / Number(sum));
}

export interface BalanceSheetRatios {
  current_ratio: Result<number>;
  quick_ratio: Result<number>;
  cash_ratio: Result<number>;
  net_debt: Result<Amount>;
  net_debt_to_equity: Result<number>;
  liabilities_to_assets: Result<number>;
  /** True when total liabilities were derived as total assets - equity. */
  liabilities_derived: boolean;
}

export interface BalanceSheetInputs {
  current_assets?: Input<Amount>;
  current_liabilities?: Input<Amount>;
  inventories?: Input<Amount>;
  cash_and_equivalents?: Input<Amount>;
  borrowings?: Input<Amount>;
  equity?: Input<Amount>;
  total_assets?: Input<Amount>;
  total_liabilities?: Input<Amount>;
}

/**
 * All balance sheet ratios from the inputs given. Without total liabilities but with total assets and equity,
 * liabilities are derived as total assets - equity and `liabilities_derived` is true.
 */
export function calculateBalanceSheetRatios(inputs: BalanceSheetInputs = {}): BalanceSheetRatios {
  const nd = netDebt(inputs.borrowings, inputs.cash_and_equivalents);
  let liabilities: Input<Amount> = inputs.total_liabilities;
  let derived = false;
  const missingLiabilities =
    liabilities === null ||
    liabilities === undefined ||
    (typeof liabilities === "object" && liabilities.status !== "ok");
  if (missingLiabilities) {
    const c = collect({ total_assets: inputs.total_assets, equity: inputs.equity });
    if ("values" in c) {
      liabilities = minus(c.values.total_assets, c.values.equity);
      derived = true;
    }
  }
  return {
    current_ratio: currentRatio(inputs.current_assets, inputs.current_liabilities),
    quick_ratio: quickRatio(inputs.current_assets, inputs.inventories, inputs.current_liabilities),
    cash_ratio: cashRatio(inputs.cash_and_equivalents, inputs.current_liabilities),
    net_debt: nd,
    net_debt_to_equity: netDebtToEquity(nd, inputs.equity),
    liabilities_to_assets: liabilitiesToAssets(liabilities, inputs.total_assets),
    liabilities_derived: derived,
  };
}

/**
 * Balance sheet ratios (docs/VIGIL.md, docs/DATA_CONTRACT.md). Every metric returns a `Result` (#65): a value, or
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

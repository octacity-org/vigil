/**
 * Balance sheet ratios (docs/VIGIL.md, docs/DATA_CONTRACT.md). No approximations: a missing input or a division by
 * zero gives null ("not computable"), never a fallback value.
 */

export type Amount = number | bigint;

const isZero = (v: Amount) => (typeof v === "bigint" ? v === 0n : v === 0);

/** a - b, exact when both are integers. */
function minus(a: Amount, b: Amount): Amount {
  return typeof a === "bigint" && typeof b === "bigint" ? a - b : Number(a) - Number(b);
}

function ratio(numerator: Amount | null, denominator: Amount | null): number | null {
  if (numerator === null || denominator === null || isZero(denominator)) return null;
  return Number(numerator) / Number(denominator);
}

/** Cari oran: dönen varlıklar / kısa vadeli yükümlülükler. */
export function currentRatio(currentAssets: Amount | null, currentLiabilities: Amount | null): number | null {
  return ratio(currentAssets, currentLiabilities);
}

/** Likidite oranı: (dönen varlıklar - stoklar) / kısa vadeli yükümlülükler. */
export function quickRatio(
  currentAssets: Amount | null,
  inventories: Amount | null,
  currentLiabilities: Amount | null,
): number | null {
  if (currentAssets === null || inventories === null) return null;
  return ratio(minus(currentAssets, inventories), currentLiabilities);
}

/** Nakit oranı: nakit ve nakit benzerleri / kısa vadeli yükümlülükler. */
export function cashRatio(cash: Amount | null, currentLiabilities: Amount | null): number | null {
  return ratio(cash, currentLiabilities);
}

/** Net borç: finansal borçlar - nakit ve nakit benzerleri (financial rule 5: one fixed definition). */
export function netDebt(borrowings: Amount | null, cash: Amount | null): number | null {
  if (borrowings === null || cash === null) return null;
  return Number(minus(borrowings, cash));
}

/** Net borç / özkaynak. */
export function netDebtToEquity(netDebtValue: Amount | null, equity: Amount | null): number | null {
  return ratio(netDebtValue, equity);
}

/** Yükümlülük / varlık: toplam yükümlülükler / toplam varlıklar. */
export function liabilitiesToAssets(totalLiabilities: Amount | null, totalAssets: Amount | null): number | null {
  return ratio(totalLiabilities, totalAssets);
}

export interface BalanceSheetRatios {
  current_ratio: number | null;
  quick_ratio: number | null;
  cash_ratio: number | null;
  net_debt: number | null;
  net_debt_to_equity: number | null;
  liabilities_to_assets: number | null;
  /** True when total liabilities were derived as total assets - equity. */
  liabilities_derived: boolean;
}

export interface BalanceSheetInputs {
  current_assets?: Amount | null;
  current_liabilities?: Amount | null;
  inventories?: Amount | null;
  cash_and_equivalents?: Amount | null;
  borrowings?: Amount | null;
  equity?: Amount | null;
  total_assets?: Amount | null;
  total_liabilities?: Amount | null;
}

/**
 * All balance sheet ratios from the inputs given. Without total liabilities but with total assets and equity,
 * liabilities are derived as total assets - equity and `liabilities_derived` is true.
 */
export function calculateBalanceSheetRatios(inputs: BalanceSheetInputs = {}): BalanceSheetRatios {
  const v = (x: Amount | null | undefined) => x ?? null;
  const nd = netDebt(v(inputs.borrowings), v(inputs.cash_and_equivalents));
  let liabilities = v(inputs.total_liabilities);
  let derived = false;
  const assets = v(inputs.total_assets);
  const equity = v(inputs.equity);
  if (liabilities === null && assets !== null && equity !== null) {
    liabilities = minus(assets, equity);
    derived = true;
  }
  return {
    current_ratio: currentRatio(v(inputs.current_assets), v(inputs.current_liabilities)),
    quick_ratio: quickRatio(v(inputs.current_assets), v(inputs.inventories), v(inputs.current_liabilities)),
    cash_ratio: cashRatio(v(inputs.cash_and_equivalents), v(inputs.current_liabilities)),
    net_debt: nd,
    net_debt_to_equity: netDebtToEquity(nd, equity),
    liabilities_to_assets: liabilitiesToAssets(liabilities, assets),
    liabilities_derived: derived,
  };
}

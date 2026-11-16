/**
 * Thresholds and definitions (#69): read from a configuration file, never written into the rule code
 * (docs/VIGIL.md §9, decisions 0011, 0015, 0018). `packages/core` only parses and validates the text; the server
 * reads the file (`config/vigil.json`) and stores `version` with every finding (#185).
 *
 * Validation is strict: a missing key, an unknown key (a typo would otherwise be silently ignored), a wrong type or a
 * value out of range throws a `ConfigError` naming the key. Nothing falls back to a built-in value.
 */

export interface VigilConfig {
  /** Name of this set of thresholds; stored with every finding. Change it whenever a value changes. */
  version: string;
  /** Default EBITDA definition (decision 0011): findings and ratios use it; the other is shown next to it. */
  ebitda_definition: "A" | "B";
  real_sector: {
    /**
     * A general-template filing whose financial-sector revenue (row 6) or cost (row 17) is above this share of its
     * revenue (row 3) is treated as a financial company, not a real-sector one.
     */
    max_financial_row_share_of_revenue: number;
  };
  /** S1, gross margin change (decision 0015). */
  s1_gross_margin: {
    /** X: the three-month gross margin changes by at least this many basis points year on year. */
    x_min_abs_delta_bps: number;
    /** Z: |Δmargin| × revenue is at least this share of the denominator (applied by #66). */
    z_min_share_of_denominator: number;
    /** The denominator of Z. */
    denominator: "total_assets";
    /** Both three-month revenues are at least this many TL. */
    min_three_month_revenue_tl: bigint;
  };
  /** S2, profit–cash divergence: the prototype's rule until #67 applies decision 0018. */
  s2_profit_cash: {
    /** Year-to-date net profit is at least this many TL. */
    min_net_profit_ytd_tl: bigint;
    /** Year-to-date operating cash flow is at most this many TL. */
    max_operating_cash_flow_ytd_tl: bigint;
  };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Obj = Record<string, unknown>;

function object(v: unknown, at: string, keys: readonly string[]): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ConfigError(`${at} must be an object`);
  const o = v as Obj;
  const unknown = Object.keys(o).filter((k) => !keys.includes(k));
  if (unknown.length > 0) throw new ConfigError(`${at}: unknown key ${unknown.map((k) => `"${k}"`).join(", ")}`);
  const missing = keys.filter((k) => !(k in o));
  if (missing.length > 0) throw new ConfigError(`${at}: missing ${missing.map((k) => `"${k}"`).join(", ")}`);
  return o;
}

function oneOf<T extends string>(v: unknown, at: string, allowed: readonly T[]): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    throw new ConfigError(`${at} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, not ${JSON.stringify(v)}`);
  }
  return v as T;
}

/** A share strictly between 0 and 1. */
function share(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1) {
    throw new ConfigError(`${at} must be a number between 0 and 1, not ${JSON.stringify(v)}`);
  }
  return v;
}

/** A whole number; amounts in TL are whole lira, as in the filings. */
function whole(v: unknown, at: string, sign: "positive" | "negative"): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || (sign === "positive" ? v <= 0 : v >= 0)) {
    throw new ConfigError(`${at} must be a ${sign} whole number, not ${JSON.stringify(v)}`);
  }
  return v;
}

/** Parse and validate a configuration file's text (JSON). */
export function parseConfig(text: string, source = "config"): VigilConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${source} is not valid JSON: ${(e as Error).message}`);
  }
  const root = object(raw, source, [
    "version",
    "ebitda_definition",
    "real_sector",
    "s1_gross_margin",
    "s2_profit_cash",
  ]);
  if (typeof root.version !== "string" || root.version.trim() === "") {
    throw new ConfigError(`${source}.version must be a non-empty string`);
  }
  const rs = object(root.real_sector, `${source}.real_sector`, ["max_financial_row_share_of_revenue"]);
  const s1At = `${source}.s1_gross_margin`;
  const s1 = object(root.s1_gross_margin, s1At, [
    "x_min_abs_delta_bps",
    "z_min_share_of_denominator",
    "denominator",
    "min_three_month_revenue_tl",
  ]);
  const s2At = `${source}.s2_profit_cash`;
  const s2 = object(root.s2_profit_cash, s2At, ["min_net_profit_ytd_tl", "max_operating_cash_flow_ytd_tl"]);
  return {
    version: root.version,
    ebitda_definition: oneOf(root.ebitda_definition, `${source}.ebitda_definition`, ["A", "B"]),
    real_sector: {
      max_financial_row_share_of_revenue: share(
        rs.max_financial_row_share_of_revenue,
        `${source}.real_sector.max_financial_row_share_of_revenue`,
      ),
    },
    s1_gross_margin: {
      x_min_abs_delta_bps: whole(s1.x_min_abs_delta_bps, `${s1At}.x_min_abs_delta_bps`, "positive"),
      z_min_share_of_denominator: share(s1.z_min_share_of_denominator, `${s1At}.z_min_share_of_denominator`),
      denominator: oneOf(s1.denominator, `${s1At}.denominator`, ["total_assets"]),
      min_three_month_revenue_tl: BigInt(
        whole(s1.min_three_month_revenue_tl, `${s1At}.min_three_month_revenue_tl`, "positive"),
      ),
    },
    s2_profit_cash: {
      min_net_profit_ytd_tl: BigInt(whole(s2.min_net_profit_ytd_tl, `${s2At}.min_net_profit_ytd_tl`, "positive")),
      max_operating_cash_flow_ytd_tl: BigInt(
        whole(s2.max_operating_cash_flow_ytd_tl, `${s2At}.max_operating_cash_flow_ytd_tl`, "negative"),
      ),
    },
  };
}

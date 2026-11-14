/**
 * The result of a metric (#65): a value, a cell the company left empty, or "not computable" with the reason and the
 * inputs that would make it computable. Same shape as `Value` / `Reason` in `@vigil/api-types` (docs/API.md), so a
 * result maps to the API without translation. Vigil never approximates: a missing input or a zero denominator is
 * never turned into 0, NaN or a fallback value.
 */

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
  /** Inputs that would make the value computable, as glossary codes (`docs/glossary.md`), e.g. `inventories`. */
  needs: string[];
}

export type Result<T> =
  | { status: "ok"; value: T }
  /** The company left the cell empty. */
  | { status: "not_reported" }
  | { status: "not_computable"; reason: Reason };

export type NotComputable = { status: "not_computable"; reason: Reason };

export const ok = <T>(value: T): Result<T> => ({ status: "ok", value });
export const notReported = <T>(): Result<T> => ({ status: "not_reported" });
export const notComputable = (code: ReasonCode, message: string, needs: string[] = []): NotComputable => ({
  status: "not_computable",
  reason: { code, message, needs },
});

/**
 * An input to a metric: a plain value, a result from another metric or from a filing, or `null` / `undefined` when
 * the row is not in the report.
 */
export type Input<T> = T | Result<T> | null | undefined;

/** Turkish names of the glossary codes used in messages. A code without a name is shown as the code. */
export const INPUT_NAMES_TR: Readonly<Record<string, string>> = {
  current_assets: "Dönen varlıklar",
  current_liabilities: "Kısa vadeli yükümlülükler",
  inventories: "Stoklar",
  cash: "Nakit ve nakit benzerleri",
  financial_debt: "Finansal borçlar",
  equity: "Özkaynaklar",
  total_assets: "Toplam varlıklar",
  total_liabilities: "Toplam yükümlülükler",
  net_debt: "Net borç",
};

const nameTr = (code: string) => INPUT_NAMES_TR[code] ?? code;

function isResult<T>(x: Input<T>): x is Result<T> {
  return typeof x === "object" && x !== null && "status" in x;
}

/**
 * The values of all inputs, or one "not computable" result that names every input that is missing, not reported or
 * itself not computable. An input that is not computable passes its own needs on, so the reason always points at
 * data that is actually absent.
 */
export function collect<K extends string, T>(inputs: Record<K, Input<T>>): { values: Record<K, T> } | NotComputable {
  const values = {} as Record<K, T>;
  const absent: string[] = [];
  const needs: string[] = [];
  for (const key of Object.keys(inputs) as K[]) {
    const input = inputs[key];
    if (input === null || input === undefined) {
      absent.push(key);
      needs.push(key);
      continue;
    }
    // A plain value is an ok result. Inputs are amounts, never objects with a `status`.
    const x: Result<T> = isResult<T>(input) ? input : ok<T>(input as T);
    if (x.status === "ok") {
      values[key] = x.value;
    } else if (x.status === "not_reported") {
      absent.push(key);
      needs.push(key);
    } else {
      absent.push(key);
      needs.push(...(x.reason.needs.length > 0 ? x.reason.needs : [key]));
    }
  }
  if (absent.length === 0) return { values };
  const unique = [...new Set(needs)];
  return notComputable(
    "missing_input",
    `Hesaplanamaz: ${absent.map(nameTr).join(", ")} raporda yok veya hesaplanamadı.`,
    unique,
  );
}

/** `notComputable` for a zero denominator, naming it. */
export function zeroDenominator(code: string): NotComputable {
  return notComputable("zero_denominator", `Hesaplanamaz: ${nameTr(code)} sıfır.`, []);
}

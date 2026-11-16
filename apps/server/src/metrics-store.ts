/**
 * Metrics in DuckDB (#184): a metric of a report is stored as its value or as the reason it cannot be computed (#65),
 * so the UI can say "not computable" and what would be needed. The inputs it used are stored with it, each with the
 * fact it was read from (disclosure, row, column), which `facts` turns into a full source reference (#72).
 *
 * A report's metrics are replaced as a whole, in one transaction; loading the report again removes them, because they
 * were computed from the old facts (#209 computes them again).
 */
import type { Result } from "@vigil/core";
import { type Database, rows } from "./db.ts";

export type MetricUnit = "TRY" | "ratio" | "bps" | "days" | "count";
export type PeriodType = "point_in_time" | "cumulative" | "three_month" | "ttm";

/** The version of the metric definitions in this release, as in the API's `definition.version`. */
export const METRIC_DEFINITIONS_VERSION = "2026-11-01";

/** Where an input was read: one cell of a report. */
export interface FactRef {
  disclosure_id: number;
  row_id: string;
  column_class: string;
}

export interface MetricInputValue {
  /** Glossary code, e.g. `revenue`. */
  code: string;
  result: Result<bigint | number>;
  unit: MetricUnit;
  /** Null for an input that is not a cell (another metric) or a row the report does not have. */
  source: FactRef | null;
}

export interface MetricValue {
  metric_code: string;
  period_type: PeriodType;
  /** `YYYY-MM-DD`; null for a point in time. */
  period_start: string | null;
  period_end: string;
  result: Result<bigint | number>;
  unit: MetricUnit;
  formula: string | null;
  inputs: MetricInputValue[];
}

/** A value as exact text: a whole TL amount as its digits, a ratio as the shortest text that reads back the same. */
export function valueText(v: bigint | number): string {
  if (typeof v === "bigint") return v.toString();
  if (!Number.isFinite(v)) throw new RangeError(`not a finite value: ${v}`);
  return Object.is(v, -0) ? "0" : String(v);
}

const resultText = (r: Result<bigint | number>) => (r.status === "ok" ? valueText(r.value) : null);

/**
 * Replace the metrics of one report with `metrics`, in one transaction. Throws for a metric listed twice for the same
 * period or a value that is not finite, and writes nothing then.
 */
export async function writeMetrics(
  db: Database,
  report: { disclosure_id: number; company_code: string },
  metrics: readonly MetricValue[],
  options: { definitionVersion?: string; computedAt?: Date } = {},
): Promise<void> {
  const version = options.definitionVersion ?? METRIC_DEFINITIONS_VERSION;
  const computedAt = (options.computedAt ?? new Date()).toISOString().replace("Z", "");
  const id = BigInt(report.disclosure_id);
  // Check every value before writing, so a bad one leaves the earlier metrics as they were.
  const keys = new Set<string>();
  for (const m of metrics) {
    const key = `${m.metric_code} ${m.period_type} ${m.period_end}`;
    if (keys.has(key)) throw new Error(`metric ${key} is listed twice for disclosure ${report.disclosure_id}`);
    keys.add(key);
    resultText(m.result);
    for (const i of m.inputs) resultText(i.result);
  }
  await db.con.run("BEGIN TRANSACTION");
  try {
    await db.con.run("DELETE FROM metric_inputs WHERE disclosure_id = $1", [id]);
    await db.con.run("DELETE FROM metrics WHERE disclosure_id = $1", [id]);
    for (const m of metrics) {
      const reason = m.result.status === "not_computable" ? m.result.reason : null;
      await db.con.run(
        `INSERT INTO metrics VALUES ($1, $2, $3, $4, $5::DATE, $6::DATE, $7, $8, $9, $10, $11, $12::VARCHAR[], $13, $14,
           $15::TIMESTAMP)`,
        [
          id,
          report.company_code,
          m.metric_code,
          m.period_type,
          m.period_start,
          m.period_end,
          m.result.status,
          resultText(m.result),
          m.unit,
          reason?.code ?? null,
          reason?.message ?? null,
          reason === null ? null : JSON.stringify(reason.needs),
          m.formula,
          version,
          computedAt,
        ] as never,
      );
      for (const [position, i] of m.inputs.entries()) {
        await db.con.run("INSERT INTO metric_inputs VALUES ($1, $2, $3, $4::DATE, $5, $6, $7, $8, $9, $10, $11, $12)", [
          id,
          m.metric_code,
          m.period_type,
          m.period_end,
          position,
          i.code,
          i.result.status,
          resultText(i.result),
          i.unit,
          i.source === null ? null : BigInt(i.source.disclosure_id),
          i.source?.row_id ?? null,
          i.source?.column_class ?? null,
        ] as never);
      }
    }
    await db.con.run("COMMIT");
  } catch (e) {
    await db.con.run("ROLLBACK");
    throw e;
  }
}

/** A stored metric, as read back: the columns of `metrics` with its inputs in order. */
export async function readMetrics(db: Database, disclosureId: number): Promise<Record<string, unknown>[]> {
  const metrics = await rows(
    db,
    `SELECT * EXCLUDE (computed_at, period_start, period_end), strftime(period_start, '%Y-%m-%d') AS period_start,
       strftime(period_end, '%Y-%m-%d') AS period_end
     FROM metrics WHERE disclosure_id = $1 ORDER BY metric_code, period_type, period_end`,
    [BigInt(disclosureId)],
  );
  const inputs = await rows(
    db,
    `SELECT metric_code, period_type, strftime(period_end, '%Y-%m-%d') AS period_end, input_code, status, value, unit,
       source_disclosure_id, source_row_id, source_column_class
     FROM metric_inputs WHERE disclosure_id = $1 ORDER BY metric_code, period_type, period_end, position`,
    [BigInt(disclosureId)],
  );
  return metrics.map((m) => ({
    ...m,
    inputs: inputs
      .filter(
        (i) => i.metric_code === m.metric_code && i.period_type === m.period_type && i.period_end === m.period_end,
      )
      .map(({ metric_code, period_type, period_end, ...rest }) => rest),
  }));
}

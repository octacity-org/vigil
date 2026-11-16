/**
 * Findings in DuckDB (#185): the output of the rules (S1–S3, `packages/core/src/signals.ts`), stored with the config
 * version of the thresholds they were found under. One finding per rule, report and config version: running the
 * rules again replaces, never adds.
 *
 * Names follow `docs/API.md` ("Finding"): `rule` is `gross_margin_change` (S1), `profit_cash_divergence` (S2) or
 * `restated_comparatives` (S3); internal codes do not leave the server. `size` is the change a list sorts by: S1 in
 * basis points, S2 in TL (profit minus operating cash flow), S3 as the number of restated balance sheet lines.
 *
 * Each finding's calculation is stored with it (#186): `finding_steps` and `finding_inputs` hold every step and every
 * value read from a filing with its source (#72), so the finding can be recomputed from the database alone and the card
 * never recomputes. Loading a report again removes its findings, which were found in the old facts.
 */
import type { Calculation, SignalObject, Step } from "@vigil/core";
import { type Database, rows } from "./db.ts";

export type Rule = "gross_margin_change" | "profit_cash_divergence" | "restated_comparatives";

const RULES: Record<SignalObject["signal_type"], { rule: Rule; size: string; unit: "bps" | "TRY" | "count" }> = {
  GROSS_MARGIN_DEVIATION: { rule: "gross_margin_change", size: "delta_bps", unit: "bps" },
  CASH_PROFIT_QUALITY_DIVERGENCE: { rule: "profit_cash_divergence", size: "profit_minus_ocf_gap_tl", unit: "TRY" },
  RETROSPECTIVE_RESTATEMENT_TRIPWIRE: {
    rule: "restated_comparatives",
    size: "restated_balance_sheet_line_count",
    unit: "count",
  },
};

export interface FindingRow {
  id: string;
  rule: Rule;
  company_code: string;
  disclosure_id: number;
  year: number;
  quarter: number;
  title: string;
  size_value: string;
  size_unit: "bps" | "TRY" | "count";
  rank_score: number;
  summary: string;
  formula: string;
  calculation_formula: string;
  definition_id: string;
}

/** A signal as a findings row. Throws for a signal whose period or size is not what its rule produces. */
export function findingRow(s: SignalObject): FindingRow {
  const r = RULES[s.signal_type];
  if (r === undefined) throw new Error(`unknown signal type ${s.signal_type}`);
  const m = /^(\d{4})-Q([1-4])$/.exec(s.period);
  if (m === null) throw new Error(`signal ${s.signal_id}: period ${s.period} is not YYYY-Qn`);
  const size = s.summary_metrics[r.size];
  if (typeof size !== "bigint" && !(typeof size === "number" && Number.isInteger(size))) {
    throw new Error(`signal ${s.signal_id}: ${r.size} is ${String(size)}, not a whole number`);
  }
  const [year, quarter] = [Number(m[1]), Number(m[2])];
  if (s.calculation.definition.id !== r.rule) {
    throw new Error(`signal ${s.signal_id}: calculation is for ${s.calculation.definition.id}, not ${r.rule}`);
  }
  return {
    id: `${year}-${quarter}-${s.company_code}-${r.rule}`,
    rule: r.rule,
    company_code: s.company_code,
    disclosure_id: s.disclosure_id,
    year,
    quarter,
    title: s.neutral_title,
    size_value: size.toString(),
    size_unit: r.unit,
    rank_score: s.severity_rank_score,
    summary: JSON.stringify(s.summary_metrics, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    formula: s.formula,
    calculation_formula: s.calculation.formula,
    definition_id: s.calculation.definition.id,
  };
}

export interface FindingsWrite {
  /** Findings that were not there before under this config. */
  added: number;
  /** Findings found again: their values replaced, their first `created_at` kept. */
  kept: number;
  /** Findings of these reports under this config that the rules no longer find. */
  removed: number;
}

/**
 * Store the findings of a run over `disclosureIds` under `configVersion` (the configuration's `version`, #69), in one
 * transaction. For those reports and
 * that config, the stored findings become exactly `signals`: a finding found again keeps when it was first found, one
 * no longer found is removed. Findings of other reports, or under other configs, are not touched.
 */
export async function writeFindings(
  db: Database,
  disclosureIds: readonly number[],
  signals: readonly SignalObject[],
  options: { configVersion: string; now?: Date },
): Promise<FindingsWrite> {
  const config = options.configVersion;
  const now = (options.now ?? new Date()).toISOString().replace("Z", "");
  const scope = new Set(disclosureIds);
  const found = signals.map(findingRow);
  for (const sig of signals) {
    if (sig.calculation.definition.version !== config) {
      throw new Error(
        `signal ${sig.signal_id} was computed under config ${sig.calculation.definition.version}, not ${config}`,
      );
    }
  }
  const keys = new Set<string>();
  for (const f of found) {
    if (!scope.has(f.disclosure_id))
      throw new Error(`finding ${f.id} is for disclosure ${f.disclosure_id}, not in this run`);
    const key = `${f.rule} ${f.disclosure_id}`;
    if (keys.has(key)) throw new Error(`finding ${f.id} is listed twice`);
    keys.add(key);
  }
  const ids = [...scope].map((id) => BigInt(id));
  const out: FindingsWrite = { added: 0, kept: 0, removed: 0 };
  await db.con.run("BEGIN TRANSACTION");
  try {
    const before = new Map<string, unknown>();
    if (ids.length > 0) {
      const existing = await rows(
        db,
        `SELECT rule, disclosure_id, created_at FROM findings
         WHERE config_version = $1 AND list_contains($2::BIGINT[], disclosure_id)`,
        [config, JSON.stringify(ids.map(String))] as never,
      );
      for (const e of existing) before.set(`${e.rule} ${e.disclosure_id}`, e.created_at);
      for (const table of ["finding_inputs", "finding_steps", "findings"]) {
        await db.con.run(
          `DELETE FROM ${table} WHERE config_version = $1 AND list_contains($2::BIGINT[], disclosure_id)`,
          [config, JSON.stringify(ids.map(String))] as never,
        );
      }
    }
    for (const [i, f] of found.entries()) {
      const first = before.get(`${f.rule} ${f.disclosure_id}`);
      if (first === undefined) out.added += 1;
      else out.kept += 1;
      await db.con.run(
        `INSERT INTO findings (id, rule, company_code, disclosure_id, year, quarter, title, size_value, size_unit,
           rank_score, summary, formula, config_version, created_at, calculation_formula, definition_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::TIMESTAMP, $15, $16)`,
        [
          f.id,
          f.rule,
          f.company_code,
          BigInt(f.disclosure_id),
          f.year,
          f.quarter,
          f.title,
          f.size_value,
          f.size_unit,
          f.rank_score,
          f.summary,
          f.formula,
          config,
          first === undefined ? now : (first as Date).toISOString().replace("Z", ""),
          f.calculation_formula,
          f.definition_id,
        ] as never,
      );
      await writeCalculation(db, f, config, (signals[i] as SignalObject).calculation);
    }
    out.removed = before.size - out.kept;
    await db.con.run("COMMIT");
  } catch (e) {
    await db.con.run("ROLLBACK");
    throw e;
  }
  return out;
}

/** A finding's steps and inputs, in the transaction of `writeFindings`. */
async function writeCalculation(db: Database, f: FindingRow, config: string, c: Calculation): Promise<void> {
  const key = [f.rule, BigInt(f.disclosure_id), config];
  for (const [position, step] of c.steps.entries()) {
    const read = "value" in step;
    await db.con.run("INSERT INTO finding_steps VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      ...key,
      position,
      step.id,
      step.label,
      read ? null : step.formula,
      read ? step.value.value : step.result,
    ] as never);
    if (!read) continue;
    const v = step.value;
    const src = v.source;
    await db.con.run(
      `INSERT INTO finding_inputs VALUES ($1, $2, $3, $4, $5, $6, $7::DATE, $8::DATE, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23, $24::TIMESTAMP, $25)`,
      [
        ...key,
        position,
        v.value,
        v.unit,
        v.period.start,
        v.period.end,
        v.period.type,
        v.period.label,
        v.period.currency_part,
        src.system,
        src.document_id,
        src.company_code,
        src.report.year,
        src.report.quarter,
        src.report.consolidation,
        src.table,
        src.row,
        src.row_label,
        src.column,
        src.shown_value,
        src.scale,
        src.published_at === null ? null : src.published_at.replace("Z", ""),
        src.url,
      ] as never,
    );
  }
}

/** The key of a stored finding. */
export interface FindingKey {
  rule: Rule;
  disclosure_id: number;
  config_version: string;
}

/**
 * A stored finding's calculation, rebuilt from `findings`, `finding_steps` and `finding_inputs` alone, in the shape
 * of `docs/API.md`. Null if there is no such finding, or it was stored before its steps were (schema version 8).
 */
export async function readCalculation(db: Database, key: FindingKey): Promise<Calculation | null> {
  const params = [key.rule, BigInt(key.disclosure_id), key.config_version];
  const [finding] = await rows(
    db,
    `SELECT calculation_formula, definition_id FROM findings
     WHERE rule = $1 AND disclosure_id = $2 AND config_version = $3`,
    params,
  );
  if (finding === undefined || finding.calculation_formula === null) return null;
  const steps = await rows(
    db,
    `SELECT s.position, s.step_id, s.label, s.formula, s.result, i.* EXCLUDE (rule, disclosure_id, config_version,
       position, period_start, period_end, published_at),
       strftime(i.period_start, '%Y-%m-%d') AS period_start, strftime(i.period_end, '%Y-%m-%d') AS period_end,
       strftime(i.published_at, '%Y-%m-%dT%H:%M:%SZ') AS published_at, i.position IS NOT NULL AS read
     FROM finding_steps s LEFT JOIN finding_inputs i USING (rule, disclosure_id, config_version, position)
     WHERE s.rule = $1 AND s.disclosure_id = $2 AND s.config_version = $3
     ORDER BY s.position`,
    params,
  );
  return {
    formula: finding.calculation_formula as string,
    definition: {
      id: finding.definition_id as string,
      version: key.config_version,
      url: `/methodology/${finding.definition_id}`,
    },
    steps: steps.map((r): Step => {
      if (!r.read) {
        return {
          id: r.step_id as string,
          label: r.label as string,
          formula: r.formula as string,
          result: r.result as string,
        };
      }
      return {
        id: r.step_id as string,
        label: r.label as string,
        value: {
          value: r.value as string,
          unit: "TRY",
          status: "ok",
          period: {
            start: (r.period_start as string | null) ?? null,
            end: r.period_end as string,
            type: r.period_type as "point_in_time" | "cumulative" | "three_month",
            label: r.period_label as string,
            currency_part: r.currency_part as "total" | "tp" | "yp",
          },
          source: {
            system: r.source_system as "KAP",
            document_id: r.document_id as string,
            company_code: r.company_code as string,
            report: {
              year: Number(r.report_year),
              quarter: Number(r.report_quarter),
              consolidation: (r.consolidation as "consolidated" | "standalone" | null) ?? null,
            },
            table: r.table_id as string,
            row: r.row_id as string,
            row_label: r.row_label as string,
            column: r.column_class as string,
            period_label: r.period_label as string,
            shown_value: r.shown_value as string,
            scale: r.scale as string,
            published_at: (r.published_at as string | null) ?? null,
            url: r.url as string,
          },
        },
      };
    }),
  };
}

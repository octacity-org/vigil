/**
 * Findings in DuckDB (#185): the output of the rules (S1–S3, `packages/core/src/signals.ts`), stored with the config
 * version of the thresholds they were found under. One finding per rule, report and config version: running the
 * rules again replaces, never adds.
 *
 * Names follow `docs/API.md` ("Finding"): `rule` is `gross_margin_change` (S1), `profit_cash_divergence` (S2) or
 * `restated_comparatives` (S3); internal codes do not leave the server. `size` is the change a list sorts by: S1 in
 * basis points, S2 in TL (profit minus operating cash flow), S3 as the number of restated balance sheet lines.
 *
 * Where each number came from is #186; loading a report again removes its findings, which were found in the old facts.
 */
import type { SignalObject } from "@vigil/core";
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
      await db.con.run(
        "DELETE FROM findings WHERE config_version = $1 AND list_contains($2::BIGINT[], disclosure_id)",
        [config, JSON.stringify(ids.map(String))] as never,
      );
    }
    for (const f of found) {
      const first = before.get(`${f.rule} ${f.disclosure_id}`);
      if (first === undefined) out.added += 1;
      else out.kept += 1;
      await db.con.run(
        "INSERT INTO findings VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::TIMESTAMP)",
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
        ] as never,
      );
    }
    out.removed = before.size - out.kept;
    await db.con.run("COMMIT");
  } catch (e) {
    await db.con.run("ROLLBACK");
    throw e;
  }
  return out;
}

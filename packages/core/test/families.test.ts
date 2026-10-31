/** Template families: `par-banks` is read (#124), an unknown family fails loudly, a third TP/YP period is mapped (#125). */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectRestatementTripwire, parseKapXls } from "../src/index.ts";
import { PUBLISHED, RAW_DIR } from "./helpers.ts";

const shown = (v: number) => v.toLocaleString("en-US").replaceAll(",", ".");
const valueCell = (c: number, v: number) =>
  `<td class="taxonomy-context-value col-order-class-${c}"><div><div title="${v}">${shown(v)}</div></div></td>`;

/** Layout of ALBRK 2026/2: participation bank, TP / YP / Toplam balance sheet. */
function bankFiling(family: string, thirdPeriod = false): string {
  const values = [301992, 239721, 541713, 246018, 224981, 470999];
  const cells = values.map((v, i) => valueCell(i + 4, v)).join("");
  const extra = thirdPeriod ? [340581, 530808, 871389].map((v, i) => valueCell(i + 10, v)).join("") : "";
  const labels = ["Cari Dönem <br>30.06.2026", "Önceki Dönem <br>31.12.2025"];
  if (thirdPeriod) labels.push("Bir Önceki Dönem <br>31.12.2024");
  const headers = [...labels, "TP", "YP", "Toplam", "TP", "YP", "Toplam"]
    .map((h) => `<td class="context-header"><div>${h}</div></td>`)
    .join("");
  return (
    `<html><body>${PUBLISHED}` +
    "<table><tr><td>Sunum Para Birimi</td><td>1.000.000 TL</td></tr></table>" +
    `<table class="financial-table tbl_${family}_role_210013" border="1"><tr>${headers}</tr>` +
    `<tr class="${family}_role_210013-row-49 data-input-row presentation-enabled">` +
    `<td><div class="gwt-Label multi-language-content content-tr">VARLIKLAR TOPLAMI</div></td>${cells}${extra}</tr>` +
    "</table></body></html>"
  );
}

describe("par-banks", () => {
  test("is read like banks", () => {
    const f = parseKapXls(bankFiling("par-banks"), "ALBRK-ALK_1644748_2026_2.xls");
    expect(f.template_family).toBe("par-banks");
    expect(new Set(f.facts.map((x) => x.row_id))).toEqual(new Set(["par-banks_role_210013-row-49"]));
    expect(Object.fromEntries(f.facts.map((x) => [x.column_class.slice(-1), [x.period_type, x.raw_value]]))).toEqual({
      "4": ["POINT_IN_TIME_TP", 301992n],
      "5": ["POINT_IN_TIME_YP", 239721n],
      "6": ["POINT_IN_TIME", 541713n],
      "7": ["POINT_IN_TIME_TP", 246018n],
      "8": ["POINT_IN_TIME_YP", 224981n],
      "9": ["POINT_IN_TIME", 470999n],
    });
    expect(f.facts[0]?.normalized_value_tl).toBe(301992n * 1_000_000n);
  });

  test("its total column is not a restatement", () => {
    // Column 6 is the current total in a TP / YP / Toplam balance sheet, not a third period.
    expect(detectRestatementTripwire(parseKapXls(bankFiling("par-banks"), "ALBRK-ALK_1644748_2026_2.xls"))).toBeNull();
  });
});

test.each(["new-family", "leasing"])("an unknown family fails loudly: %s", (family) => {
  expect(() => parseKapXls(bankFiling(family), "ALBRK-ALK_1644748_2026_2.xls")).toThrow(
    `Unknown template family ${family}`,
  );
});

test("a third TP / YP / Toplam period is mapped (EXIMB, VDFAS 2026/2)", () => {
  const facts = new Map(
    parseKapXls(bankFiling("banks", true), "EXIMB-THR_1644741_2026_2.xls").facts.map((x) => [x.column_class, x]),
  );
  const third = [10, 11, 12].map((c) => {
    const x = facts.get(`col-order-class-${c}`);
    return [x?.period_type, x?.period_end, x?.raw_value];
  });
  expect(third).toEqual([
    ["POINT_IN_TIME_TP", "2024-12-31", 340581n],
    ["POINT_IN_TIME_YP", "2024-12-31", 530808n],
    ["POINT_IN_TIME", "2024-12-31", 871389n],
  ]);
  expect([7, 8, 9, 10, 11, 12].every((c) => facts.get(`col-order-class-${c}`)?.is_restated_comparative)).toBe(true);
  expect(facts.get("col-order-class-9")?.period_end).toBe("2025-12-31");
});

// Real ALBRK files, when downloaded (tests/raw_files.txt).
const albrk = readdirSafe().flatMap(([q, names]) =>
  names.filter((n) => n.startsWith("ALBRK-ALK_")).map((n) => join(RAW_DIR, q, n)),
);

function readdirSafe(): [string, string[]][] {
  try {
    return readdirSync(RAW_DIR)
      .filter((q) => q.startsWith("2026_"))
      .map((q) => [q, readdirSync(join(RAW_DIR, q))]);
  } catch {
    return [];
  }
}

describe.skipIf(albrk.length === 0)("ALBRK key totals (raw files)", () => {
  test.each(albrk)("%s", (path) => {
    const f = parseKapXls(readFileSync(path), path.split(/[\\/]/).pop() as string);
    const value = (role: string, label: string, col: string) => {
      const found = f.facts.filter((x) => x.role_code === role && x.label_tr === label && x.column_class === col);
      expect(found).toHaveLength(1);
      return found[0]?.raw_value;
    };
    for (const col of ["col-order-class-6", "col-order-class-9"]) {
      expect(value("210013", "VARLIKLAR TOPLAMI", col)).toBe(value("210013", "YÜKÜMLÜLÜKLER TOPLAMI", col));
    }
    expect(value("310019", "DÖNEM NET KARI VEYA ZARARI", "col-order-class-4")).toBe(
      value("210013", "Dönem Net Kâr veya Zararı", "col-order-class-6"),
    );
  });
});

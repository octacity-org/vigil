/**
 * Parser tests with synthetic fixtures that have the header, table and cell structure of KAP files (docs/kap.md), so
 * no KAP content is committed. Real files are covered by golden.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  ParseError,
  parseKapXls,
  periodDates,
  periodMatchesQuarter,
  periodMonths,
  specialFiscalPeriod,
} from "../src/index.ts";
import { PUBLISHED } from "./helpers.ts";

// --- scale (#35, #132) -------------------------------------------------------------------------------------------

function scaleFiling(unitCells: string): string {
  return `<html><head><meta http-equiv="Content-Type" content="text/html;" charset="utf-8"></head><body>
${PUBLISHED}
<table><tr>${unitCells}<td>Finansal Tablo Niteliği</td><td>Konsolide</td></tr></table>
<table class="financial-table tbl_general_role_210015" border="1">
<tr><td class="context-header"><div>Cari Dönem <br>30.06.2026</div></td></tr>
<tr class="general_role_210015-row-4 data-input-row presentation-enabled">
<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>
<td class="taxonomy-context-value col-order-class-4"><div title="39369">39.369</div></td>
</tr></table></body></html>`;
}

const unit = (u: string) => `<td>Sunum Para Birimi</td><td>${u}</td>`;

describe("scale: the shown value is unscaled and multiplied by Sunum Para Birimi", () => {
  test.each([
    ["TL", 1n],
    ["1.000 TL", 1_000n],
    ["1.000.000 TL", 1_000_000n],
  ])("%s", (u, multiplier) => {
    const f = parseKapXls(scaleFiling(unit(u)), "TEST_1000001_2026_2.xls");
    expect(f.scale_unit).toBe(u);
    expect(f.scale_multiplier).toBe(multiplier);
    expect(f.facts).toHaveLength(1);
    expect(f.facts[0]?.raw_value).toBe(39369n);
    expect(f.facts[0]?.normalized_value_tl).toBe(39369n * multiplier);
    expect(f.consolidation_type).toBe("Konsolide");
  });

  test("a missing unit raises", () => {
    expect(() => parseKapXls(scaleFiling(""), "TEST_1000001_2026_2.xls")).toThrow(/Sunum Para Birimi/);
  });

  test("an unknown unit raises", () => {
    expect(() => parseKapXls(scaleFiling(unit("1.000 USD")), "TEST_1000001_2026_2.xls")).toThrow(/1\.000 USD/);
  });
});

// --- cells are read one by one (#14) ------------------------------------------------------------------------------

describe("value cells", () => {
  // Modelled on KATMR 2026/2 row 42: the 2026 cells are empty and the 2025 cells hold a value.
  const FILING = `<html><body>${PUBLISHED}
<table><tr><td>Sunum Para Birimi</td><td>TL</td><td>Finansal Tablo Niteliği</td><td>Konsolide</td></tr></table>
<table class="financial-table tbl_general_role_310003" border="1">
<tr>
<td class="context-header"><div>Cari Dönem <br>01.01.2026 - 30.06.2026</div></td>
<td class="context-header"><div>Önceki Dönem <br>01.01.2025 - 30.06.2025</div></td>
<td class="context-header"><div>Cari Dönem 3 Aylık <br>01.04.2026 - 30.06.2026</div></td>
<td class="context-header"><div>Önceki Dönem 3 Aylık <br>01.04.2025 - 30.06.2025</div></td>
</tr>
<tr class="general_role_310003-row-42 data-input-row presentation-enabled">
<td><table><tr><td>
<div class="gwt-Label multi-language-content content-tr">Yatırım Faaliyetlerinden Giderler</div>
</td></tr></table></td>
<td class="taxonomy-context-value col-order-class-4"><div><div class="gwt-Label"></div></div></td>
<td class="taxonomy-context-value col-order-class-5">
<div><div class="gwt-Label" title="-36464628">-36.464.628</div></div></td>
<td class="taxonomy-context-value col-order-class-6"><div><div class="gwt-Label"></div></div></td>
<td class="taxonomy-context-value col-order-class-7">
<div><div class="gwt-Label" title="-36464628">-36.464.628</div></div></td>
</tr>
</table></body></html>`;

  test("empty cells stay empty", () => {
    const f = parseKapXls(FILING, "TEST_1000002_2026_2.xls");
    expect(Object.fromEntries(f.facts.map((x) => [x.column_class, x.raw_value]))).toEqual({
      "col-order-class-5": -36464628n,
      "col-order-class-7": -36464628n,
    });
  });
});

// --- the shown number is the value (#137, #148, decision 0005) ---------------------------------------------------

describe("shown number vs title", () => {
  const HEAD = `<html><body>${PUBLISHED}
<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>
<table class="financial-table tbl_general_role_210015" border="1">
<tr class="general_role_210015-row-4 data-input-row presentation-enabled">
<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>
`;
  const cell = (col: number, inner: string) =>
    `<td class="taxonomy-context-value col-order-class-${col}"><div>${inner}</div></td>\n`;
  const parse = (cells: string[]) =>
    parseKapXls(`${HEAD}${cells.join("")}</tr></table></body></html>`, "TEST_1000003_2026_2.xls");
  const values = (f: ReturnType<typeof parse>) => Object.fromEntries(f.facts.map((x) => [x.column_class, x.raw_value]));

  test("a value without title is read from its text (YONGA 2026/2)", () => {
    const f = parse([
      cell(4, '<div class="gwt-Label"> 1.432.817.618 </div>'),
      cell(5, '<div class="gwt-Label"> -27.026.098 </div>'),
      cell(6, '<div class="gwt-Label"> 0 </div>'),
    ]);
    expect(values(f)).toEqual({
      "col-order-class-4": 1432817618n,
      "col-order-class-5": -27026098n,
      "col-order-class-6": 0n,
    });
    expect([f.title_disagreements, f.titles_without_text]).toEqual([0, 0]);
  });

  test("the text wins over a different title (AVHOL 2026/1)", () => {
    const f = parse([
      cell(4, '<div class="gwt-Label" title="468518587"> 465.518.587 </div>'),
      cell(5, '<div class="gwt-Label" title="45507361"> 45.507.361 </div>'),
    ]);
    expect(values(f)).toEqual({ "col-order-class-4": 465518587n, "col-order-class-5": 45507361n });
    expect([f.title_disagreements, f.titles_without_text]).toEqual([1, 0]);
  });

  test("a title without text is empty (ZOREN 2026/2)", () => {
    const f = parse([
      cell(4, '<div class="gwt-Label" title="1248245"></div>'),
      cell(5, '<div class="gwt-Label"> 7 </div>'),
    ]);
    expect(values(f)).toEqual({ "col-order-class-5": 7n });
    expect([f.title_disagreements, f.titles_without_text]).toEqual([0, 1]);
  });

  test("an empty cell stays empty", () => {
    const f = parse([cell(4, '<div class="gwt-Label"></div>'), cell(5, '<div class="gwt-Label"> 7 </div>')]);
    expect(f.facts.map((x) => [x.column_class, x.raw_value])).toEqual([["col-order-class-5", 7n]]);
  });

  for (const title of ["", ' title="1000"']) {
    test.each(["1,5", "(1.000)", "1.000,50", "12.34", "abc", "1 000"])(
      `unknown text format fails loudly: %s (title ${title || "none"})`,
      (text) => {
        expect(() => parse([cell(4, `<div class="gwt-Label"${title}> ${text} </div>`)])).toThrow(
          /Unexpected value text/,
        );
      },
    );
  }
});

// --- periods come from the column header dates (#36) --------------------------------------------------------------

describe("periods", () => {
  const header = (...labels: string[]) =>
    `<tr>${labels.map((x) => `<td class="context-header"><div>${x}</div></td>`).join("")}</tr>`;
  const table = (role: string, headers: string, columns: number[]) =>
    `<table class="financial-table tbl_general_role_${role}" border="1">${headers}` +
    `<tr class="general_role_${role}-row-4 data-input-row presentation-enabled">` +
    `<td><div class="gwt-Label multi-language-content content-tr">Satır</div></td>` +
    columns
      .map(
        (c) => `<td class="taxonomy-context-value col-order-class-${c}"><div><div title="${c}">${c}</div></div></td>`,
      )
      .join("") +
    "</tr></table>";
  const parse = (quarter: number, ...tables: string[]) =>
    parseKapXls(
      `<html><body>${PUBLISHED}<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>${tables.join("")}</body></html>`,
      `TEST_1000004_2026_${quarter}.xls`,
    );
  const byColumn = (f: ReturnType<typeof parse>, role: string) =>
    Object.fromEntries(
      f.facts
        .filter((x) => x.role_code === role)
        .map((x) => [x.column_class.slice(-1), [x.period_type, x.period_start, x.period_end]]),
    );

  test("MAVI: the fiscal year starts on 1 February", () => {
    const f = parse(
      2,
      table("210015", header("Cari Dönem <br>31.07.2026", "Önceki Dönem <br>31.01.2026"), [4, 5]),
      table(
        "310003",
        header(
          "Cari Dönem <br>01.02.2026 - 31.07.2026",
          "Önceki Dönem <br>01.02.2025 - 31.07.2025",
          "Cari Dönem 3 Aylık <br>01.05.2026 - 31.07.2026",
          "Önceki Dönem 3 Aylık <br>01.05.2025 - 31.07.2025",
        ),
        [4, 5, 6, 7],
      ),
    );
    expect(byColumn(f, "210015")).toEqual({
      "4": ["POINT_IN_TIME", null, "2026-07-31"],
      "5": ["POINT_IN_TIME", null, "2026-01-31"],
    });
    expect(byColumn(f, "310003")).toEqual({
      "4": ["YTD_CUMULATIVE", "2026-02-01", "2026-07-31"],
      "5": ["YTD_CUMULATIVE", "2025-02-01", "2025-07-31"],
      "6": ["Q_STANDALONE", "2026-05-01", "2026-07-31"],
      "7": ["Q_STANDALONE", "2025-05-01", "2025-07-31"],
    });
    expect([f.period_start, f.period_end]).toEqual(["2026-02-01", "2026-07-31"]);
    expect([periodMonths(f), specialFiscalPeriod(f), periodMatchesQuarter(f)]).toEqual([6, true, true]);
  });

  test("a first quarter is one quarter", () => {
    const f = parse(
      1,
      table(
        "520003",
        header("Cari Dönem <br>01.01.2026 - 31.03.2026", "Önceki Dönem <br>01.01.2025 - 31.03.2025"),
        [4, 5],
      ),
    );
    expect(byColumn(f, "520003")["4"]).toEqual(["Q_STANDALONE", "2026-01-01", "2026-03-31"]);
    expect([periodMonths(f), specialFiscalPeriod(f), periodMatchesQuarter(f)]).toEqual([3, false, true]);
  });

  test("a header period disagreeing with the file name is flagged", () => {
    const f = parse(
      3,
      table(
        "520003",
        header("Cari Dönem <br>01.01.2026 - 30.06.2026", "Önceki Dönem <br>01.01.2025 - 30.06.2025"),
        [4, 5],
      ),
    );
    expect(byColumn(f, "520003")["4"]).toEqual(["YTD_CUMULATIVE", "2026-01-01", "2026-06-30"]);
    expect(periodMatchesQuarter(f)).toBe(false);
  });

  test("a table without header dates", () => {
    const f = parse(2, table("520003", "", [4]));
    expect(byColumn(f, "520003")["4"]).toEqual(["YTD_CUMULATIVE", null, null]);
    expect([f.period_start, f.period_end, periodMatchesQuarter(f)]).toEqual([null, null, null]);
  });

  test.each([
    ["Cari Dönem 01.01.2026 - 30.06.2026", ["2026-01-01", "2026-06-30"]],
    ["Önceki Dönem 31.12.2025", [null, "2025-12-31"]],
    ["Cari Dönem (TP) 30.06.2026", [null, "2026-06-30"]],
    ["col-order-class-10", [null, null]],
    ["30.06.2026 - 01.01.2026", [null, null]],
    ["31.02.2026", [null, null]],
  ])("periodDates(%s)", (label, expected) => {
    expect(periodDates(label)).toEqual(expected as [string | null, string | null]);
  });
});

// --- publication time (#157) ---------------------------------------------------------------------------------------

describe("publication time", () => {
  const BODY =
    "<table><tr><td>Sunum Para Birimi</td><td>TL</td></tr></table>" +
    '<table class="financial-table tbl_general_role_210015" border="1">' +
    '<tr><td class="context-header"><div>Cari Dönem <br>30.06.2026</div></td></tr>' +
    '<tr class="general_role_210015-row-4 data-input-row presentation-enabled">' +
    '<td><div class="gwt-Label multi-language-content content-tr">Nakit ve Nakit Benzerleri</div></td>' +
    '<td class="taxonomy-context-value col-order-class-4"><div><div title="7">7</div></div></td></tr></table>';
  const parse = (header: string) =>
    parseKapXls(
      `<html><body><h1 style="font-size: medium">Finansal Rapor</h1>${header}<div> Bildirim Tipi:FR </div>${BODY}</body></html>`,
      "KATMR_1651411_2026_2.xls",
    );

  test("is read from the header", () => {
    expect(parse("<div> Gönderim Tarihi:17.08.2026 19:05:18 </div>").published_at).toBe("2026-08-17T19:05:18");
  });

  test("a missing publication time fails loudly", () => {
    expect(() => parse("")).toThrow(/Gönderim Tarihi/);
  });

  test.each(["17.08.2026", "2026-08-17 19:05:18", "17.08.2026 19:05", ""])(
    "an unexpected value fails loudly: %p",
    (value) => {
      expect(() => parse(`<div> Gönderim Tarihi:${value} </div>`)).toThrow(/publication time/);
    },
  );
});

describe("errors", () => {
  test("parse errors are ParseError", () => {
    expect(() => parseKapXls("<html>no tables</html>", "TEST_1_2026_2.xls")).toThrow(ParseError);
  });

  test("a file name that is not a KAP file name is rejected", () => {
    expect(() => parseKapXls(scaleFiling(unit("TL")), "something.xls")).toThrow(/Unexpected KAP filename format/);
  });
});

"""Cross-statement reconciliation checks (issue #18).

Ratios are computed only after the statements of a filing agree with each other. Every check compares two
values from the same filing, so both are in the same reporting unit and purchasing power, and must be equal.

Supported templates: `general` and `holding`, which share the balance sheet and cash flow layout. Other
templates are reported as `not_checked` with the reason; nothing is guessed.

Severity (decision 0003, proposed):
- `blocking`: the balance sheet balances, and its profit equals the income statement's parent-company profit.
  A filing that fails one of these should not produce signals.
- `informational`: cash in the cash flow statement versus cash in the balance sheet. Many filings define cash
  in the cash flow statement without interest accruals, blocked deposits or expected credit losses (IAS 7,
  explained in the notes), so a difference is reported but does not block the filing.

Values are compared in the filing's reporting unit; a difference of one unit is treated as rounding.
"""

from __future__ import annotations

import dataclasses
from typing import Dict, List, Optional, Sequence, Tuple

from vigil.parser import ParsedFiling, ParsedFinancialFact

SUPPORTED_FAMILIES = ("general", "holding")

CURRENT = "col-order-class-4"
PRIOR = "col-order-class-5"

ROUNDING_TOLERANCE = 1  # one unit of the reporting unit (1 TL, 1,000 TL or 1,000,000 TL)

# (role code, row number) candidates and the label that must be on that row. The label guards against a
# template that renumbers its rows: a different label gives `not_checked` instead of a wrong comparison.
TOTAL_ASSETS = ([("210015", 129)], "TOPLAM VARLIKLAR")
TOTAL_LIABILITIES_AND_EQUITY = ([("210015", 297)], "TOPLAM KAYNAKLAR")
BS_NET_PROFIT = ([("210015", 294)], "Net Dönem Karı veya Zararı")
BS_CASH = ([("210015", 4)], "Nakit ve Nakit Benzerleri")
PARENT_PROFIT = ([("310003", 62), ("310000", 62), ("310002", 62), ("310004", 64)], "Ana Ortaklık Payları")
CF_CASH_END = ([("520003", 209), ("510011", 121)], "DÖNEM SONU NAKİT VE NAKİT BENZERLERİ")
CF_CASH_BEGIN = ([("520003", 207), ("510011", 119)], "DÖNEM BAŞI NAKİT VE NAKİT BENZERLERİ")

RowSpec = Tuple[List[Tuple[str, int]], str]


@dataclasses.dataclass(frozen=True)
class CheckResult:
    name: str
    severity: str  # "blocking" | "informational"
    status: str  # "pass" | "fail" | "not_checked"
    left: Optional[int] = None  # raw values, in the filing's reporting unit
    right: Optional[int] = None
    left_source: Optional[str] = None  # "row_id column"
    right_source: Optional[str] = None
    reason: Optional[str] = None

    @property
    def difference(self) -> Optional[int]:
        if self.left is None or self.right is None:
            return None
        return self.left - self.right


def _find(
    facts: Dict[Tuple[str, str], ParsedFinancialFact], family: str, spec: RowSpec, column: str
) -> Tuple[Optional[ParsedFinancialFact], Optional[str]]:
    candidates, label = spec
    for role, row in candidates:
        fact = facts.get((f"{family}_role_{role}-row-{row}", column))
        if fact is None:
            continue
        if fact.label_tr != label:
            return None, f"{fact.row_id} is {fact.label_tr!r}, expected {label!r}"
        return fact, None
    rows = ", ".join(f"{role}-row-{row}" for role, row in candidates)
    return None, f"no value for {label!r} ({rows}) in {column}"


def _compare(
    name: str,
    severity: str,
    facts: Dict[Tuple[str, str], ParsedFinancialFact],
    family: str,
    left: RowSpec,
    left_column: str,
    right: RowSpec,
    right_column: str,
) -> CheckResult:
    lf, l_reason = _find(facts, family, left, left_column)
    rf, r_reason = _find(facts, family, right, right_column)
    if lf is None or rf is None:
        return CheckResult(name, severity, "not_checked", reason="; ".join(r for r in (l_reason, r_reason) if r))
    return CheckResult(
        name,
        severity,
        "pass" if abs(lf.raw_value - rf.raw_value) <= ROUNDING_TOLERANCE else "fail",
        left=lf.raw_value,
        right=rf.raw_value,
        left_source=f"{lf.row_id} {left_column}",
        right_source=f"{rf.row_id} {right_column}",
    )


CHECKS: Sequence[Tuple[str, str, RowSpec, str, RowSpec, str]] = (
    (
        "total_assets_equal_liabilities_and_equity_current",
        "blocking",
        TOTAL_ASSETS,
        CURRENT,
        TOTAL_LIABILITIES_AND_EQUITY,
        CURRENT,
    ),
    (
        "total_assets_equal_liabilities_and_equity_prior",
        "blocking",
        TOTAL_ASSETS,
        PRIOR,
        TOTAL_LIABILITIES_AND_EQUITY,
        PRIOR,
    ),
    ("balance_sheet_profit_equals_parent_profit", "blocking", BS_NET_PROFIT, CURRENT, PARENT_PROFIT, CURRENT),
    ("cash_flow_end_cash_equals_balance_sheet_cash", "informational", CF_CASH_END, CURRENT, BS_CASH, CURRENT),
    ("cash_flow_begin_cash_equals_prior_balance_sheet_cash", "informational", CF_CASH_BEGIN, CURRENT, BS_CASH, PRIOR),
)


def reconcile(filing: ParsedFiling) -> List[CheckResult]:
    """Run the cross-statement checks on one filing. Unsupported templates give `not_checked`."""
    if filing.template_family not in SUPPORTED_FAMILIES:
        reason = f"template {filing.template_family!r} is not supported yet"
        return [CheckResult(name, severity, "not_checked", reason=reason) for name, severity, *_ in CHECKS]
    facts = {(f.row_id, f.column_class): f for f in filing.facts}
    return [_compare(name, severity, facts, filing.template_family, *spec) for name, severity, *spec in CHECKS]


def blocking_failures(results: Sequence[CheckResult]) -> List[CheckResult]:
    """Blocking checks that failed. A filing with any of these should not produce signals."""
    return [r for r in results if r.severity == "blocking" and r.status == "fail"]


# Income statement subtotals (issue #15). Values carry their sign (costs are negative), so every subtotal is
# a plain sum of its components. Row numbers are the same in the general income statement variants 310003,
# 310000 and 310002; each formula held in every 2026/2 filing that reports its components.
INCOME_STATEMENT_ROLES = ("310003", "310000", "310002")
INCOME_STATEMENT_COLUMNS = ("col-order-class-4", "col-order-class-5", "col-order-class-6", "col-order-class-7")
INCOME_STATEMENT_SUBTOTALS: Sequence[Tuple[int, str, Sequence[int]]] = (
    (5, "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)", (3, 4)),
    (6, "Finans Sektörü Faaliyetleri Hasılatı", tuple(range(7, 17))),
    (17, "Finans Sektörü Faaliyetleri Maliyeti", tuple(range(18, 29))),
    (29, "FİNANS SEKTÖRÜ FAALİYETLERİNDEN BRÜT KAR (ZARAR)", (6, 17)),
    (31, "BRÜT KAR (ZARAR)", (5, 29, 30)),
    (38, "ESAS FAALİYET KARI (ZARARI)", (31, 32, 33, 34, 35, 36, 37)),
    (49, "FİNANSMAN GELİRİ (GİDERİ) ÖNCESİ FAALİYET KARI (ZARARI)", (38, *range(39, 49))),
    (53, "SÜRDÜRÜLEN FAALİYETLER VERGİ ÖNCESİ KARI (ZARARI)", (49, 50, 51, 52)),
    (54, "Sürdürülen Faaliyetler Vergi (Gideri) Geliri", (55, 56)),
    (57, "SÜRDÜRÜLEN FAALİYETLER DÖNEM KARI (ZARARI)", (53, 54)),
    (59, "DÖNEM KARI (ZARARI)", (57, 58)),
    (59, "DÖNEM KARI (ZARARI)", (61, 62)),
)


def income_statement_subtotals(filing: ParsedFiling) -> List[CheckResult]:
    """Recompute each income statement subtotal from its components, per column (#15)."""
    return _subtotals(
        filing,
        "income_statement",
        ("general",),
        INCOME_STATEMENT_ROLES,
        INCOME_STATEMENT_COLUMNS,
        INCOME_STATEMENT_SUBTOTALS,
    )


# Balance sheet subtotals (issue #16). Every group in the general balance sheet (210015, also used by the
# holding template) is the sum of the rows below it; each formula held in every 2026/2 filing that reports its
# components (12,885 comparisons). Column 6 is the restated comparative column, when present.
BALANCE_SHEET_ROLES = ("210015",)
BALANCE_SHEET_COLUMNS = ("col-order-class-4", "col-order-class-5", "col-order-class-6")
BALANCE_SHEET_SUBTOTALS: Sequence[Tuple[int, str, Sequence[int]]] = (
    (
        6,
        "Finansal Yatırımlar",
        (
            *range(7, 12),
            16,
            *range(19, 22),
        ),
    ),
    (11, "Gerçeğe Uygun Değer Farkı Kar/Zarara Yansıtılan Finansal Varlıklar", (*range(12, 16),)),
    (
        16,
        "Gerçeğe Uygun Değer Farkı Diğer Kapsamlı Gelire Yansıtılan Finansal Varlıklar",
        (
            17,
            18,
        ),
    ),
    (
        22,
        "Ticari Alacaklar",
        (
            23,
            24,
        ),
    ),
    (
        25,
        "Finans Sektörü Faaliyetlerinden Alacaklar",
        (
            26,
            27,
        ),
    ),
    (
        29,
        "Diğer Alacaklar",
        (
            30,
            31,
        ),
    ),
    (32, "Müşteri Sözleşmelerinden Doğan Varlıklar", (*range(33, 36),)),
    (
        37,
        "Türev Araçlar",
        (
            38,
            39,
        ),
    ),
    (
        43,
        "Peşin Ödenmiş Giderler",
        (
            44,
            45,
        ),
    ),
    (
        49,
        "Diğer Dönen Varlıklar",
        (
            50,
            51,
        ),
    ),
    (
        52,
        "ARA TOPLAM",
        (
            *range(4, 7),
            22,
            25,
            28,
            29,
            32,
            36,
            37,
            *range(40, 44),
            *range(46, 50),
        ),
    ),
    (55, "TOPLAM DÖNEN VARLIKLAR", (*range(52, 55),)),
    (
        57,
        "Finansal Yatırımlar",
        (
            *range(58, 63),
            67,
            70,
            71,
        ),
    ),
    (62, "Gerçeğe Uygun Değer Farkı Kar/Zarara Yansıtılan Finansal Varlıklar", (*range(63, 67),)),
    (
        67,
        "Gerçeğe Uygun Değer Farkı Diğer Kapsamlı Gelire Yansıtılan Finansal Varlıklar",
        (
            68,
            69,
        ),
    ),
    (
        73,
        "Ticari Alacaklar",
        (
            74,
            75,
        ),
    ),
    (
        76,
        "Finans Sektörü Faaliyetlerinden Alacaklar",
        (
            77,
            78,
        ),
    ),
    (
        79,
        "Diğer Alacaklar",
        (
            80,
            81,
        ),
    ),
    (82, "Müşteri Sözleşmelerinden Doğan Varlıklar", (*range(83, 86),)),
    (
        87,
        "Türev Araçlar",
        (
            88,
            89,
        ),
    ),
    (95, "Maddi Duran Varlıklar", (*range(96, 108),)),
    (109, "Maddi Olmayan Duran Varlıklar", (*range(110, 119),)),
    (
        119,
        "Peşin Ödenmiş Giderler",
        (
            120,
            121,
        ),
    ),
    (
        125,
        "Diğer Duran Varlıklar",
        (
            126,
            127,
        ),
    ),
    (
        128,
        "TOPLAM DURAN VARLIKLAR",
        (
            57,
            72,
            73,
            76,
            79,
            82,
            86,
            87,
            *range(90, 96),
            108,
            109,
            119,
            *range(122, 126),
        ),
    ),
    (
        129,
        "TOPLAM VARLIKLAR",
        (
            55,
            128,
        ),
    ),
    (
        132,
        "Kısa Vadeli Borçlanmalar",
        (
            133,
            138,
        ),
    ),
    (133, "İlişkili Taraflardan Kısa Vadeli Borçlanmalar", (*range(134, 138),)),
    (138, "İlişkili Olmayan Taraflardan Kısa Vadeli Borçlanmalar", (*range(139, 143),)),
    (
        143,
        "Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları",
        (
            144,
            149,
        ),
    ),
    (144, "İlişkili Taraflardan Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları", (*range(145, 149),)),
    (149, "İlişkili Olmayan Taraflardan Uzun Vadeli Borçlanmaların Kısa Vadeli Kısımları", (*range(150, 154),)),
    (154, "Diğer Finansal Yükümlülükler", (*range(155, 158),)),
    (
        158,
        "Ticari Borçlar",
        (
            159,
            160,
        ),
    ),
    (
        161,
        "Finans Sektörü Faaliyetlerinden Borçlar",
        (
            162,
            163,
        ),
    ),
    (
        165,
        "Diğer Borçlar",
        (
            166,
            167,
        ),
    ),
    (168, "Müşteri Sözleşmelerinden Doğan Yükümlülükler", (*range(169, 172),)),
    (
        173,
        "Türev Araçlar",
        (
            174,
            175,
        ),
    ),
    (
        177,
        "Ertelenmiş Gelirler (Müşteri Sözleşmelerinden Doğan Yükümlülüklerin Dışında Kalanlar)",
        (
            178,
            179,
        ),
    ),
    (181, "Kısa Vadeli Karşılıklar", (*range(182, 185),)),
    (
        185,
        "Diğer Kısa Vadeli Yükümlülükler",
        (
            186,
            187,
        ),
    ),
    (
        188,
        "ARA TOPLAM",
        (
            132,
            143,
            154,
            158,
            161,
            164,
            165,
            168,
            172,
            173,
            176,
            177,
            180,
            181,
            185,
        ),
    ),
    (191, "TOPLAM KISA VADELİ YÜKÜMLÜLÜKLER", (*range(188, 191),)),
    (
        193,
        "Uzun Vadeli Borçlanmalar",
        (
            194,
            199,
        ),
    ),
    (194, "İlişkili Taraflardan Uzun Vadeli Borçlanmalar", (*range(195, 199),)),
    (199, "İlişkili Olmayan Taraflardan Uzun Vadeli Borçlanmalar", (*range(200, 204),)),
    (204, "Diğer Finansal Yükümlülükler", (*range(205, 208),)),
    (
        208,
        "Ticari Borçlar",
        (
            209,
            210,
        ),
    ),
    (
        211,
        "Finans Sektörü Faaliyetlerinden Borçlar",
        (
            212,
            213,
        ),
    ),
    (
        215,
        "Diğer Borçlar",
        (
            216,
            217,
        ),
    ),
    (218, "Müşteri Sözleşmelerinden Doğan Yükümlülükler", (*range(219, 222),)),
    (
        223,
        "Türev Araçlar",
        (
            224,
            225,
        ),
    ),
    (
        227,
        "Ertelenmiş Gelirler (Müşteri Sözleşmelerinden Doğan Yükümlülüklerin Dışında Kalanlar)",
        (
            228,
            229,
        ),
    ),
    (230, "Uzun Vadeli Karşılıklar", (*range(231, 236),)),
    (
        238,
        "Diğer Uzun Vadeli Yükümlülükler",
        (
            239,
            240,
        ),
    ),
    (
        241,
        "TOPLAM UZUN VADELİ YÜKÜMLÜLÜKLER",
        (
            193,
            204,
            208,
            211,
            214,
            215,
            218,
            222,
            223,
            226,
            227,
            230,
            *range(236, 239),
        ),
    ),
    (
        242,
        "TOPLAM YÜKÜMLÜLÜKLER",
        (
            191,
            241,
        ),
    ),
    (
        244,
        "Ana Ortaklığa Ait Özkaynaklar",
        (
            *range(245, 257),
            269,
            284,
            *range(290, 295),
        ),
    ),
    (
        256,
        "Kar veya Zararda Yeniden Sınıflandırılmayacak Birikmiş Diğer Kapsamlı Gelirler (Giderler)",
        (
            257,
            258,
            *range(264, 269),
        ),
    ),
    (258, "Yeniden Değerleme ve Ölçüm Kazançları (Kayıpları)", (*range(259, 264),)),
    (
        269,
        "Kar veya Zararda Yeniden Sınıflandırılacak Birikmiş Diğer Kapsamlı Gelirler (Giderler)",
        (
            270,
            271,
            275,
            *range(279, 284),
        ),
    ),
    (271, "Riskten Korunma Kazançları (Kayıpları)", (*range(272, 275),)),
    (275, "Yeniden Değerleme ve Sınıflandırma Kazançları (Kayıpları)", (*range(276, 279),)),
    (284, "Kardan Ayrılan Kısıtlanmış Yedekler", (*range(285, 290),)),
    (
        296,
        "TOPLAM ÖZKAYNAKLAR",
        (
            244,
            295,
        ),
    ),
    (
        297,
        "TOPLAM KAYNAKLAR",
        (
            242,
            296,
        ),
    ),
)


def balance_sheet_subtotals(filing: ParsedFiling) -> List[CheckResult]:
    """Recompute each balance sheet subtotal from its components, per column (#16)."""
    return _subtotals(
        filing,
        "balance_sheet",
        SUPPORTED_FAMILIES,
        BALANCE_SHEET_ROLES,
        BALANCE_SHEET_COLUMNS,
        BALANCE_SHEET_SUBTOTALS,
    )


def _subtotals(
    filing: ParsedFiling,
    statement: str,
    families: Sequence[str],
    roles: Sequence[str],
    columns: Sequence[str],
    formulas: Sequence[Tuple[int, str, Sequence[int]]],
) -> List[CheckResult]:
    """
    Recompute subtotals from their components, per column.

    - A subtotal whose components are all unreported is `not_checked`: the company gave only the total.
    - Each component may be rounded by one reporting unit, so the tolerance is the number of components.
    - These checks are `blocking`: a mismatch means a parsing error or an inconsistent filing.
    """
    family = filing.template_family
    role = next((r for r in roles if r in filing.role_codes), None)
    if family not in families or role is None:
        reason = f"{statement} subtotals are defined for {'/'.join(families)} ({', '.join(roles)})"
        return [CheckResult(f"{statement}_subtotals", "blocking", "not_checked", reason=reason)]

    facts = {(f.row_id, f.column_class): f for f in filing.facts if f.role_code == role}
    if not facts:
        reason = f"no {statement.replace('_', ' ')} values were parsed for {role}"
        return [CheckResult(f"{statement}_subtotals", "blocking", "not_checked", reason=reason)]

    def row_id(n: int) -> str:
        return f"{family}_role_{role}-row-{n}"

    results: List[CheckResult] = []
    for total_row, label, parts in formulas:
        name = f"{statement}_row_{total_row}_equals_rows_{'+'.join(str(p) for p in parts)}"
        for column in columns:
            components = [facts[(row_id(p), column)] for p in parts if (row_id(p), column) in facts]
            total = facts.get((row_id(total_row), column))
            source = f"{row_id(total_row)} {column}"
            if not components:
                if total is not None:
                    results.append(
                        CheckResult(name, "blocking", "not_checked", reason=f"{source}: components not reported")
                    )
                continue
            if total is not None and total.label_tr != label:
                reason = f"{total.row_id} is {total.label_tr!r}, expected {label!r}"
                results.append(CheckResult(name, "blocking", "not_checked", reason=reason))
                continue
            total_value = total.raw_value if total is not None else 0
            parts_sum = sum(f.raw_value for f in components)
            results.append(
                CheckResult(
                    name,
                    "blocking",
                    "pass" if abs(total_value - parts_sum) <= ROUNDING_TOLERANCE * len(parts) else "fail",
                    left=total_value,
                    right=parts_sum,
                    left_source=source,
                    right_source=", ".join(f"{f.row_id}" for f in components),
                )
            )
    return results

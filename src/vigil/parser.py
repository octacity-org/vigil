from __future__ import annotations

import dataclasses
import html
import os
import re
from typing import Dict, List, Optional, Tuple

SCALE_MAP: Dict[str, int] = {
    "TL": 1,
    "1 TL": 1,
    "1.000 TL": 1_000,
    "BİN TL": 1_000,
    "1.000.000 TL": 1_000_000,
    "MİLYON TL": 1_000_000,
}


def classify_statement_role(role_code: str) -> str:
    """Classify 6-digit KAP XBRL role code into canonical statement type."""
    if role_code.startswith("2105"):
        return "OFF_BALANCE_SHEET"
    if role_code.startswith("21"):
        return "BALANCE_SHEET"
    if role_code.startswith("31"):
        return "INCOME_STATEMENT"
    if role_code.startswith("41") or role_code.startswith("42"):
        return "COMPREHENSIVE_INCOME"
    if role_code.startswith("51"):
        return "CASH_FLOW_DIRECT"
    if role_code.startswith("52"):
        return "CASH_FLOW_INDIRECT"
    if role_code.startswith("61"):
        return "EQUITY_CHANGES"
    return "OTHER"


@dataclasses.dataclass
class ColumnMeta:
    col_class: str  # e.g. "col-order-class-4"
    header_text: str  # e.g. "Cari Dönem 01.01.2026 - 30.06.2026"
    period_type: str  # "POINT_IN_TIME" | "YTD_CUMULATIVE" | "Q_STANDALONE"
    is_comparative: bool  # False for Cari Dönem, True for Önceki Dönem


@dataclasses.dataclass
class ParsedFinancialFact:
    company_code: str
    raw_ticker_group: str
    disclosure_id: int
    year: int
    quarter: int
    consolidation_type: str
    template_family: str
    role_code: str
    statement_type: str
    row_id: str
    label_tr: str
    footnote_ref: Optional[str]
    column_class: str
    period_type: str
    period_label: str
    is_restated_comparative: bool
    raw_value: int
    scale_unit: str
    scale_multiplier: int
    normalized_value_tl: int


@dataclasses.dataclass
class ParsedFiling:
    filepath: str
    company_code: str
    raw_ticker_group: str
    disclosure_id: int
    year: int
    quarter: int
    scale_unit: str
    scale_multiplier: int
    consolidation_type: str
    template_family: str
    role_codes: List[str]
    has_tms29_monetary_item: bool
    facts: List[ParsedFinancialFact]


FILENAME_RE = re.compile(r"^([A-Z0-9-]+)_(\d+)_(\d{4})_([1-4])\.xls$", re.IGNORECASE)
HEADER_SCALE_RE = re.compile(r"Sunum Para Birimi\s*</td>\s*<td[^>]*>\s*([^<]+?)\s*</td>", re.S)
HEADER_CONSOL_RE = re.compile(r"Finansal Tablo Niteli[^<]*</td>\s*<td[^>]*>\s*([^<]+?)\s*</td>", re.S)
ROLE_TABLE_RE = re.compile(r'<table[^>]*class="[^"]*tbl_(\w+)_role_(\d{6})[^"]*"[^>]*>', re.S)
ROW_START_RE = re.compile(
    r'<tr\s+class="((?:[a-z]+)_role_\d{6}-row-\d+)\s+data-input-row[^"]*"[^>]*>',
    re.S,
)
LABEL_TR_RE = re.compile(r'class="[^"]*content-tr[^"]*"[^>]*>\s*(.*?)\s*</div>', re.S)
FOOTNOTE_RE = re.compile(r'class="taxonomy-footnote-value"[^>]*>\s*(.*?)\s*</div>', re.S)
VALUE_CELL_RE = re.compile(
    r'<td\s+class="taxonomy-context-value\s+(col-order-class-\d+)[^"]*"[^>]*>.*?'
    r'title="([-+]?\d+(?:[.,]\d+)?)"',
    re.S,
)


def parse_filename(filepath: str) -> Tuple[str, str, int, int, int]:
    basename = os.path.basename(filepath)
    m = FILENAME_RE.match(basename)
    if not m:
        raise ValueError(f"Unexpected KAP filename format: {basename}")
    raw_ticker_group = m.group(1).upper()
    primary_ticker = raw_ticker_group.split("-")[0]
    disclosure_id = int(m.group(2))
    year = int(m.group(3))
    quarter = int(m.group(4))
    return primary_ticker, raw_ticker_group, disclosure_id, year, quarter


def _clean_text(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def _build_columns_for_statement(statement_type: str, table_html_head: str, quarter: int) -> Dict[str, ColumnMeta]:
    """Infer column metadata for col-order-class-4..7 in a statement table."""
    header_cells = [_clean_text(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", table_html_head, re.S)]
    period_headers = [c for c in header_cells if "Cari Dönem" in c or "Önceki Dönem" in c]

    cols: Dict[str, ColumnMeta] = {}
    if statement_type in ("BALANCE_SHEET", "OFF_BALANCE_SHEET"):
        has_tp_yp = "TP" in header_cells and "YP" in header_cells and "Toplam" in header_cells
        c_label = period_headers[0] if len(period_headers) > 0 else "Cari Dönem"
        p_label = period_headers[1] if len(period_headers) > 1 else "Önceki Dönem"
        if has_tp_yp:
            cols["col-order-class-4"] = ColumnMeta("col-order-class-4", f"{c_label} (TP)", "POINT_IN_TIME_TP", False)
            cols["col-order-class-5"] = ColumnMeta("col-order-class-5", f"{c_label} (YP)", "POINT_IN_TIME_YP", False)
            cols["col-order-class-6"] = ColumnMeta("col-order-class-6", f"{c_label} (Toplam)", "POINT_IN_TIME", False)
            cols["col-order-class-7"] = ColumnMeta("col-order-class-7", f"{p_label} (TP)", "POINT_IN_TIME_TP", True)
            cols["col-order-class-8"] = ColumnMeta("col-order-class-8", f"{p_label} (YP)", "POINT_IN_TIME_YP", True)
            cols["col-order-class-9"] = ColumnMeta("col-order-class-9", f"{p_label} (Toplam)", "POINT_IN_TIME", True)
        else:
            cols["col-order-class-4"] = ColumnMeta(
                col_class="col-order-class-4",
                header_text=c_label,
                period_type="POINT_IN_TIME",
                is_comparative=False,
            )
            cols["col-order-class-5"] = ColumnMeta(
                col_class="col-order-class-5",
                header_text=p_label,
                period_type="POINT_IN_TIME",
                is_comparative=True,
            )
            cols["col-order-class-6"] = ColumnMeta(
                col_class="col-order-class-6",
                header_text=period_headers[2] if len(period_headers) > 2 else "Bir Önceki Dönem",
                period_type="POINT_IN_TIME",
                is_comparative=True,
            )
    elif statement_type in ("INCOME_STATEMENT", "COMPREHENSIVE_INCOME"):
        ptype_main = "Q_STANDALONE" if quarter == 1 else "YTD_CUMULATIVE"
        cols["col-order-class-4"] = ColumnMeta(
            col_class="col-order-class-4",
            header_text=period_headers[0] if len(period_headers) > 0 else "Cari Dönem",
            period_type=p_type if (p_type := ptype_main) else "YTD_CUMULATIVE",
            is_comparative=False,
        )
        cols["col-order-class-5"] = ColumnMeta(
            col_class="col-order-class-5",
            header_text=period_headers[1] if len(period_headers) > 1 else "Önceki Dönem",
            period_type=ptype_main,
            is_comparative=True,
        )
        cols["col-order-class-6"] = ColumnMeta(
            col_class="col-order-class-6",
            header_text=period_headers[2] if len(period_headers) > 2 else "Cari Dönem 3 Aylık",
            period_type="Q_STANDALONE",
            is_comparative=False,
        )
        cols["col-order-class-7"] = ColumnMeta(
            col_class="col-order-class-7",
            header_text=period_headers[3] if len(period_headers) > 3 else "Önceki Dönem 3 Aylık",
            period_type="Q_STANDALONE",
            is_comparative=True,
        )
    else:
        # Cash flow statements (51xxxx / 52xxxx) are always YTD cumulative
        p_cf = "Q_STANDALONE" if quarter == 1 else "YTD_CUMULATIVE"
        cols["col-order-class-4"] = ColumnMeta(
            col_class="col-order-class-4",
            header_text=period_headers[0] if len(period_headers) > 0 else "Cari Dönem",
            period_type=p_cf,
            is_comparative=False,
        )
        cols["col-order-class-5"] = ColumnMeta(
            col_class="col-order-class-5",
            header_text=period_headers[1] if len(period_headers) > 1 else "Önceki Dönem",
            period_type=p_cf,
            is_comparative=True,
        )
    return cols


def parse_kap_xls(filepath: str) -> ParsedFiling:
    """Parse a KAP .xls (UTF-8 HTML) file into structured financial facts."""
    primary_ticker, raw_ticker_group, disclosure_id, year, quarter = parse_filename(filepath)
    with open(filepath, "rb") as f:
        raw_bytes = f.read()
    try:
        raw_html = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raw_html = raw_bytes.decode("cp1254", errors="replace")

    # Values are unscaled; guessing the unit would make every value off by 1,000x or 1,000,000x (#132).
    scale_match = HEADER_SCALE_RE.search(raw_html)
    if not scale_match:
        raise ValueError(f"Reporting unit (Sunum Para Birimi) not found in {filepath}")
    scale_unit = _clean_text(scale_match.group(1))
    scale_multiplier = SCALE_MAP.get(scale_unit.upper(), SCALE_MAP.get(scale_unit))
    if scale_multiplier is None:
        raise ValueError(f"Unknown reporting unit {scale_unit!r} in {filepath}")

    consol_match = HEADER_CONSOL_RE.search(raw_html)
    consolidation_type = _clean_text(consol_match.group(1)) if consol_match else "Bilinmiyor"

    role_matches = list(ROLE_TABLE_RE.finditer(raw_html))
    if not role_matches:
        raise ValueError(f"No XBRL role tables found in {filepath}")

    template_family = role_matches[0].group(1)
    role_codes: List[str] = []
    facts: List[ParsedFinancialFact] = []
    has_tms29 = False

    for idx, rm in enumerate(role_matches):
        family = rm.group(1)
        role_code = rm.group(2)
        if role_code not in role_codes:
            role_codes.append(role_code)

        statement_type = classify_statement_role(role_code)
        if statement_type == "EQUITY_CHANGES":
            # Equity matrix has 2D equity columns; skip in Phase 0 line-item extraction
            continue

        start_pos = rm.start()
        end_pos = role_matches[idx + 1].start() if idx + 1 < len(role_matches) else len(raw_html)
        table_chunk = raw_html[start_pos:end_pos]
        col_map = _build_columns_for_statement(statement_type, table_chunk[:3500], quarter)

        row_matches = list(ROW_START_RE.finditer(table_chunk))
        for r_idx, row_m in enumerate(row_matches):
            row_id = row_m.group(1)
            r_start = row_m.start()
            r_end = row_matches[r_idx + 1].start() if r_idx + 1 < len(row_matches) else len(table_chunk)
            row_chunk = table_chunk[r_start:r_end]

            lbl_m = LABEL_TR_RE.search(row_chunk)
            if not lbl_m:
                continue
            label_tr = _clean_text(lbl_m.group(1))
            if "parasal pozisyon" in label_tr.lower():
                has_tms29 = True

            fn_m = FOOTNOTE_RE.search(row_chunk)
            footnote_ref = _clean_text(fn_m.group(1)) if fn_m else None
            if footnote_ref == "":
                footnote_ref = None

            for val_m in VALUE_CELL_RE.finditer(row_chunk):
                col_class = val_m.group(1)
                val_str = val_m.group(2).replace(",", ".")
                try:
                    raw_val = int(float(val_str))
                except ValueError:
                    continue

                col_meta = col_map.get(
                    col_class,
                    ColumnMeta(
                        col_class=col_class,
                        header_text=col_class,
                        period_type="UNKNOWN",
                        is_comparative=col_class in ("col-order-class-5", "col-order-class-7"),
                    ),
                )

                facts.append(
                    ParsedFinancialFact(
                        company_code=primary_ticker,
                        raw_ticker_group=raw_ticker_group,
                        disclosure_id=disclosure_id,
                        year=year,
                        quarter=quarter,
                        consolidation_type=consolidation_type,
                        template_family=family,
                        role_code=role_code,
                        statement_type=statement_type,
                        row_id=row_id,
                        label_tr=label_tr,
                        footnote_ref=footnote_ref,
                        column_class=col_class,
                        period_type=col_meta.period_type,
                        period_label=col_meta.header_text,
                        is_restated_comparative=col_meta.is_comparative,
                        raw_value=raw_val,
                        scale_unit=scale_unit,
                        scale_multiplier=scale_multiplier,
                        normalized_value_tl=raw_val * scale_multiplier,
                    )
                )

    return ParsedFiling(
        filepath=filepath,
        company_code=primary_ticker,
        raw_ticker_group=raw_ticker_group,
        disclosure_id=disclosure_id,
        year=year,
        quarter=quarter,
        scale_unit=scale_unit,
        scale_multiplier=scale_multiplier,
        consolidation_type=consolidation_type,
        template_family=template_family,
        role_codes=role_codes,
        has_tms29_monetary_item=has_tms29,
        facts=facts,
    )

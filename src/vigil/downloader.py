from __future__ import annotations

import os
import struct
import time
import urllib.request
import zipfile
import zlib
from typing import List

KAP_BULK_URL = "https://www.kap.org.tr/tr/api/financialTable/download/{year}/{quarter}"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/zip,application/octet-stream,*/*",
    "Referer": "https://www.kap.org.tr/tr/",
}


def salvage_partial_zip(zip_path: str, extract_dir: str) -> List[str]:
    """
    Extract all complete .xls files from a valid or truncated/interrupted ZIP file
    by scanning local file headers (PK\\x03\\x04) sequentially.
    """
    os.makedirs(extract_dir, exist_ok=True)
    extracted: List[str] = []

    if zipfile.is_zipfile(zip_path):
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                for name in zf.namelist():
                    if name.lower().endswith(".xls"):
                        zf.extract(name, extract_dir)
                        extracted.append(os.path.join(extract_dir, name))
                return extracted
        except Exception:
            pass

    data = open(zip_path, "rb").read()
    pos = 0
    sig = b"PK\x03\x04"

    while True:
        idx = data.find(sig, pos)
        if idx == -1 or idx + 30 > len(data):
            break
        (
            _ver,
            flags,
            method,
            _mtime,
            _mdate,
            crc32_expected,
            comp_size,
            uncomp_size,
            fname_len,
            extra_len,
        ) = struct.unpack("<HHHHHIIIHH", data[idx + 4 : idx + 30])
        header_end = idx + 30 + fname_len + extra_len
        if header_end > len(data):
            break

        fname = data[idx + 30 : idx + 30 + fname_len].decode("utf-8", errors="replace")
        next_sig = data.find(sig, header_end)
        chunk_end = (
            header_end + comp_size
            if (comp_size > 0 and not (flags & 0x08))
            else (next_sig if next_sig != -1 else len(data))
        )
        if chunk_end > len(data):
            break

        payload = data[header_end:chunk_end]
        try:
            if method == 0:
                raw_bytes = payload[:uncomp_size] if uncomp_size else payload
            elif method == 8:
                decomp = zlib.decompressobj(-15)
                raw_bytes = decomp.decompress(payload)
                if not decomp.eof:
                    # Truncated deflate stream at the tail of the partial zip
                    pos = header_end
                    continue
            else:
                pos = header_end
                continue

            if crc32_expected and (zlib.crc32(raw_bytes) & 0xFFFFFFFF) != crc32_expected:
                pos = header_end
                continue

            out_path = os.path.join(extract_dir, os.path.basename(fname))
            with open(out_path, "wb") as out_f:
                out_f.write(raw_bytes)
            extracted.append(out_path)
        except Exception:
            pass

        pos = max(header_end, next_sig if next_sig != -1 else len(data))

    return extracted


def download_kap_quarter_zip(
    year: int,
    quarter: int,
    target_zip_path: str,
    max_retries: int = 8,
    chunk_size: int = 256 * 1024,
) -> str:
    """
    Download KAP quarterly financial statements ZIP with automatic retry and
    HTTP Range resume support when connections drop mid-stream.
    """
    os.makedirs(os.path.dirname(os.path.abspath(target_zip_path)), exist_ok=True)
    url = KAP_BULK_URL.format(year=year, quarter=quarter)

    for attempt in range(1, max_retries + 1):
        existing_bytes = os.path.getsize(target_zip_path) if os.path.exists(target_zip_path) else 0
        if existing_bytes > 0 and zipfile.is_zipfile(target_zip_path):
            return target_zip_path

        headers = dict(DEFAULT_HEADERS)
        mode = "wb"
        if existing_bytes > 0:
            headers["Range"] = f"bytes={existing_bytes}-"
            mode = "ab"

        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = getattr(resp, "status", 200)
                if status == 200 and existing_bytes > 0:
                    # Server ignored Range header and sent from byte 0
                    mode = "wb"
                with open(target_zip_path, mode) as f:
                    while True:
                        buf = resp.read(chunk_size)
                        if not buf:
                            break
                        f.write(buf)

            if zipfile.is_zipfile(target_zip_path):
                return target_zip_path
        except Exception:
            time.sleep(min(2**attempt, 15))

    return target_zip_path

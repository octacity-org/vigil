"""Download a quarter of KAP financial statements and recover what a cut-off download contains (#38).

    python -m vigil.downloader 2026 2 data/raw

KAP behaviour measured on 2026-10-29 (docs/kap.md):
- `GET financialTable/download/{year}/{quarter}` streams one zip without `Content-Length` and ignores `Range`,
  so a cut-off download cannot be resumed; it is retried from the start.
- Every member uses a data descriptor: the local header has no sizes or CRC. A member's end is found by
  inflating its deflate stream until it ends, never by searching for the next `PK` signature, which can
  occur inside compressed data.
"""

from __future__ import annotations

import dataclasses
import os
import struct
import sys
import time
import urllib.request
import zipfile
import zlib
from typing import BinaryIO, Callable, List, Optional, Tuple

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

LOCAL_HEADER = b"PK\x03\x04"
DATA_DESCRIPTOR = b"PK\x07\x08"
CHUNK = 256 * 1024


@dataclasses.dataclass
class SalvageResult:
    complete: bool  # the archive was a valid zip and every member was read
    recovered: List[str]  # paths of the files written
    lost: List[str]  # members seen but cut off or corrupt; members after the cut are not known at all


@dataclasses.dataclass
class DownloadResult:
    zip_path: str
    attempts: int
    complete: bool
    recovered: List[str]
    lost: List[str]
    errors: List[str]


def _safe_name(member: str) -> Optional[str]:
    """Base name of an `.xls` member, so nothing is written outside the target directory."""
    name = os.path.basename(member.replace("\\", "/"))
    return name if name.lower().endswith(".xls") else None


def _write(extract_dir: str, name: str, data: bytes) -> str:
    path = os.path.join(extract_dir, name)
    with open(path, "wb") as f:
        f.write(data)
    return path


def _inflate(data: memoryview, start: int) -> Optional[Tuple[bytes, int]]:
    """Inflate one raw deflate stream. Returns (content, end offset), or None if the stream is cut off."""
    d = zlib.decompressobj(-15)
    out = []
    pos = start
    while pos < len(data):
        piece = data[pos : pos + CHUNK]
        out.append(d.decompress(piece))
        if d.eof:
            return b"".join(out), pos + len(piece) - len(d.unused_data)
        pos += len(piece)
    return None


def _scan_local_headers(data: bytes, extract_dir: str) -> SalvageResult:
    view = memoryview(data)
    result = SalvageResult(complete=False, recovered=[], lost=[])
    pos = data.find(LOCAL_HEADER)
    while pos != -1 and pos + 30 <= len(data):
        _ver, flags, method, _t, _d, crc, comp_size, _size, name_len, extra_len = struct.unpack(
            "<HHHHHIIIHH", data[pos + 4 : pos + 30]
        )
        start = pos + 30 + name_len + extra_len
        member = data[pos + 30 : pos + 30 + name_len].decode("utf-8", errors="replace")
        if start > len(data):
            if pos + 30 + name_len <= len(data):
                result.lost.append(member)  # the name is known, its data is not
            break
        has_descriptor = bool(flags & 0x08)

        try:
            if method == 8:
                inflated = _inflate(view, start)
            elif method == 0 and not has_descriptor and start + comp_size <= len(data):
                inflated = data[start : start + comp_size], start + comp_size
            else:
                inflated = None  # cut off, or stored with an unknown size: its end cannot be found
        except zlib.error:
            inflated = None
        if inflated is None:
            result.lost.append(member)
            break
        content, end = inflated

        if has_descriptor:
            if data[end : end + 4] == DATA_DESCRIPTOR:
                end += 4
            if end + 12 > len(data):
                result.lost.append(member)
                break
            crc = struct.unpack("<I", data[end : end + 4])[0]
            end += 12  # crc, compressed size, uncompressed size (KAP does not use zip64)

        name = _safe_name(member)
        if (zlib.crc32(content) & 0xFFFFFFFF) != crc:
            result.lost.append(member)
        elif name:
            result.recovered.append(_write(extract_dir, name, content))
        pos = data.find(LOCAL_HEADER, end)
    return result


def salvage_zip(zip_path: str, extract_dir: str) -> SalvageResult:
    """Write every complete `.xls` member of a zip, valid or cut off, to `extract_dir` (flat, by base name)."""
    os.makedirs(extract_dir, exist_ok=True)
    if zipfile.is_zipfile(zip_path):
        result = SalvageResult(complete=True, recovered=[], lost=[])
        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                name = _safe_name(info.filename)
                if not name:
                    continue
                try:
                    result.recovered.append(_write(extract_dir, name, zf.read(info)))
                except (zipfile.BadZipFile, zlib.error):
                    result.lost.append(info.filename)
        result.complete = not result.lost
        return result
    with open(zip_path, "rb") as f:
        return _scan_local_headers(f.read(), extract_dir)


def _open_url(url: str, headers: dict, timeout: float) -> BinaryIO:
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)


def download_quarter(
    year: int,
    quarter: int,
    raw_dir: str,
    retries: int = 5,
    timeout: float = 60,
    backoff: float = 2.0,
    open_url: Callable[[str, dict, float], BinaryIO] = _open_url,
    sleep: Callable[[float], None] = time.sleep,
) -> DownloadResult:
    """
    Download one quarter into `{raw_dir}/{year}_{quarter}.zip` and extract it to `{raw_dir}/{year}_{quarter}/`.

    Retries from the start with exponential backoff until the zip is complete. If it never is, the largest
    partial download is salvaged and the result lists what was recovered and what was lost.
    """
    os.makedirs(raw_dir, exist_ok=True)
    zip_path = os.path.join(raw_dir, f"{year}_{quarter}.zip")
    part_path = zip_path + ".part"
    url = KAP_BULK_URL.format(year=year, quarter=quarter)
    if os.path.exists(zip_path):
        os.remove(zip_path)  # never salvage a file left by an earlier run
    errors: List[str] = []
    best = 0
    attempt = 0
    for attempt in range(1, retries + 1):
        try:
            with open_url(url, dict(DEFAULT_HEADERS), timeout) as resp, open(part_path, "wb") as f:
                while True:
                    buf = resp.read(CHUNK)
                    if not buf:
                        break
                    f.write(buf)
        except Exception as e:  # network errors are retried and reported, never raised
            errors.append(f"attempt {attempt}: {type(e).__name__}: {e}")
        if zipfile.is_zipfile(part_path):
            os.replace(part_path, zip_path)
            break
        size = os.path.getsize(part_path) if os.path.exists(part_path) else 0
        if size:
            errors.append(f"attempt {attempt}: incomplete zip ({size} bytes)")
        if size > best:  # every attempt streams the same file from the start; keep the longest
            best = size
            os.replace(part_path, zip_path)
        if attempt < retries:
            sleep(backoff * 2 ** (attempt - 1))
    if os.path.exists(part_path):
        os.remove(part_path)
    if not os.path.exists(zip_path):
        return DownloadResult(zip_path, attempt, False, [], [], errors)
    salvage = salvage_zip(zip_path, os.path.join(raw_dir, f"{year}_{quarter}"))
    return DownloadResult(zip_path, attempt, salvage.complete, salvage.recovered, salvage.lost, errors)


if __name__ == "__main__":
    year, quarter = int(sys.argv[1]), int(sys.argv[2])
    raw_dir = sys.argv[3] if len(sys.argv) > 3 else os.path.join("data", "raw")
    r = download_quarter(year, quarter, raw_dir)
    for e in r.errors:
        print(e)
    state = "complete" if r.complete else "INCOMPLETE"
    print(f"{year}/{quarter}: {state} after {r.attempts} attempt(s); {len(r.recovered)} files, {len(r.lost)} lost")
    for name in r.lost:
        print("  lost:", name)
    sys.exit(0 if r.complete else 1)

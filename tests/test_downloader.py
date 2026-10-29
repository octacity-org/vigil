"""Download retries and partial-zip salvage (#38), with synthetic zips and a fake server."""

import io
import os
import random
import zipfile

import vigil.downloader as dl

# Random hex so that members do not compress to a few bytes and cut points land inside them.
MEMBERS = {f"CO{i}_100{i}_2026_2.xls": random.Random(i).randbytes(1000 + 200 * i).hex().encode() for i in range(5)}


class Unseekable(io.RawIOBase):
    """Writing a zip through this makes zipfile use data descriptors, as KAP's zips do."""

    def __init__(self):
        self.buf = io.BytesIO()

    def writable(self):
        return True

    def write(self, b):
        return self.buf.write(b)


def kap_zip(members=MEMBERS):
    out = Unseekable()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in members.items():
            zf.writestr(name, data)
    return out.buf.getvalue()


def member_end(data, name):
    """Offset just after a member's data descriptor in `data`."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        infos = sorted(zf.infolist(), key=lambda i: i.header_offset)
        offsets = [i.header_offset for i in infos] + [zf.start_dir]
    return offsets[[i.filename for i in infos].index(name) + 1]


def inside(data, name, into=100):
    """An offset `into` bytes into a member's compressed data."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return zf.getinfo(name).header_offset + 30 + len(name) + into


def salvage(tmp_path, data):
    path = tmp_path / "q.zip"
    path.write_bytes(data)
    result = dl.salvage_zip(str(path), str(tmp_path / "out"))
    files = {os.path.basename(p): open(p, "rb").read() for p in result.recovered}
    return result, files


def test_kap_style_zip_uses_data_descriptors():
    with zipfile.ZipFile(io.BytesIO(kap_zip())) as zf:
        assert all(i.flag_bits & 0x08 for i in zf.infolist())


def test_complete_zip(tmp_path):
    result, files = salvage(tmp_path, kap_zip())
    assert (result.complete, result.lost) == (True, [])
    assert files == MEMBERS


def test_cut_inside_a_member(tmp_path):
    data = kap_zip()
    cut = inside(data, "CO3_1003_2026_2.xls")
    result, files = salvage(tmp_path, data[:cut])
    assert result.complete is False
    assert files == {k: MEMBERS[k] for k in ("CO0_1000_2026_2.xls", "CO1_1001_2026_2.xls", "CO2_1002_2026_2.xls")}
    assert result.lost == ["CO3_1003_2026_2.xls"]


def test_cut_inside_a_local_header(tmp_path):
    data = kap_zip()
    name_end = inside(data, "CO1_1001_2026_2.xls", into=0)
    # CO1's name is complete but none of its data: it is reported as lost.
    result, files = salvage(tmp_path, data[:name_end])
    assert (set(files), result.lost) == ({"CO0_1000_2026_2.xls"}, ["CO1_1001_2026_2.xls"])
    # Cut inside the name: the member is not known at all.
    result, files = salvage(tmp_path, data[: name_end - 1])
    assert (set(files), result.lost) == ({"CO0_1000_2026_2.xls"}, [])


def test_cut_at_every_byte_never_writes_a_wrong_file(tmp_path):
    data = kap_zip()
    for cut in range(0, len(data), 97):
        result, files = salvage(tmp_path, data[:cut])
        assert all(MEMBERS[name] == content for name, content in files.items()), cut
        assert len(result.lost) <= 1


def test_corrupt_member_is_lost_and_the_rest_recovered(tmp_path):
    data = bytearray(kap_zip())
    crc_at = member_end(bytes(data), "CO1_1001_2026_2.xls") - 12  # CO1's descriptor CRC
    data[crc_at] ^= 0xFF
    cut = len(data) - 30  # drop the end of the central directory so the local headers are scanned
    result, files = salvage(tmp_path, bytes(data[:cut]))
    assert "CO1_1001_2026_2.xls" in result.lost
    assert set(files) == set(MEMBERS) - {"CO1_1001_2026_2.xls"}


def test_member_paths_cannot_leave_the_target_directory(tmp_path):
    data = kap_zip({"../../evil.xls": b"x", "dir/A_1_2026_2.xls": b"a", "readme.txt": b"t"})
    result, files = salvage(tmp_path, data)
    assert files == {"evil.xls": b"x", "A_1_2026_2.xls": b"a"}
    assert all(os.path.dirname(p) == str(tmp_path / "out") for p in result.recovered)


class FakeResponse(io.BytesIO):
    def __init__(self, data, fail_after=None):
        super().__init__(data if fail_after is None else data[:fail_after])
        self.fail = fail_after is not None

    def read(self, n=-1):
        buf = super().read(n)
        if not buf and self.fail:
            raise ConnectionResetError("connection dropped")
        return buf


def fake_server(*responses):
    calls = []

    def open_url(url, headers, timeout):
        calls.append(url)
        return responses[len(calls) - 1]()

    return open_url, calls


def test_retry_until_complete(tmp_path):
    data = kap_zip()
    open_url, calls = fake_server(lambda: FakeResponse(data, fail_after=500), lambda: FakeResponse(data))
    sleeps = []
    r = dl.download_quarter(2026, 2, str(tmp_path), open_url=open_url, sleep=sleeps.append)
    assert (r.complete, r.attempts, len(r.recovered), r.lost) == (True, 2, 5, [])
    assert calls == ["https://www.kap.org.tr/tr/api/financialTable/download/2026/2"] * 2
    assert sleeps == [2.0]
    assert "ConnectionResetError" in r.errors[0]
    assert sorted(os.listdir(tmp_path / "2026_2")) == sorted(MEMBERS)
    assert not os.path.exists(tmp_path / "2026_2.zip.part")


def test_never_complete_salvages_the_longest_attempt(tmp_path):
    data = kap_zip()
    cut_short = inside(data, "CO1_1001_2026_2.xls")
    cut_long = inside(data, "CO3_1003_2026_2.xls")
    open_url, _ = fake_server(
        lambda: FakeResponse(data, fail_after=cut_short),
        lambda: FakeResponse(data, fail_after=cut_long),
        lambda: FakeResponse(data, fail_after=cut_short),
    )
    sleeps = []
    r = dl.download_quarter(2026, 2, str(tmp_path), retries=3, open_url=open_url, sleep=sleeps.append)
    assert (r.complete, r.attempts) == (False, 3)
    assert sorted(os.path.basename(p) for p in r.recovered) == [f"CO{i}_100{i}_2026_2.xls" for i in range(3)]
    assert r.lost == ["CO3_1003_2026_2.xls"]
    assert sleeps == [2.0, 4.0]


def test_nothing_downloaded(tmp_path):
    def open_url(url, headers, timeout):
        raise TimeoutError("timed out")

    (tmp_path / "2026_2.zip").write_bytes(kap_zip())  # left by an earlier run, must not be used
    r = dl.download_quarter(2026, 2, str(tmp_path), retries=2, open_url=open_url, sleep=lambda s: None)
    assert (r.complete, r.recovered, r.lost, len(r.errors)) == (False, [], [], 2)

/** Download retries and partial-zip salvage (#38), with synthetic KAP-style zips and a fake server. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { downloadQuarter, fetchFiles, type OpenUrl, salvageZip } from "../src/downloader.ts";

/** Deterministic pseudo-random bytes, as hex text, so members do not compress to a few bytes. */
function randomHex(seed: number, length: number): Buffer {
  let x = seed * 2654435761 + 1;
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return Buffer.from(bytes.toString("hex"));
}

const MEMBERS: Record<string, Buffer> = Object.fromEntries(
  [0, 1, 2, 3, 4].map((i) => [`CO${i}_100${i}_2026_2.xls`, randomHex(i + 1, 1000 + 200 * i)]),
);

interface Layout {
  data: Buffer;
  /** Offset of each member's local header, and of the central directory. */
  offsets: Record<string, number>;
  centralDirectory: number;
}

/** A zip written like KAP's: deflated members with data descriptors (sizes and CRC after the data). */
function kapZip(members: Record<string, Buffer> = MEMBERS): Layout {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: Record<string, number> = {};
  let offset = 0;
  for (const [name, content] of Object.entries(members)) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(content);
    const crc = crc32(content) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(nameLength(nameBytes), 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed.length, 8);
    descriptor.writeUInt32LE(content.length, 12);
    offsets[name] = offset;
    parts.push(local, nameBytes, compressed, descriptor);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x08, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(content.length, 24);
    c.writeUInt16LE(nameBytes.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBytes);
    offset += 30 + nameBytes.length + compressed.length + 16;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return { data: Buffer.concat([...parts, cd, end]), offsets, centralDirectory: offset };
}

function nameLength(b: Buffer): number {
  return b.length;
}

/** Offset just after a member's data descriptor. */
function memberEnd(z: Layout, name: string): number {
  const names = Object.keys(z.offsets);
  const next = names[names.indexOf(name) + 1];
  return next === undefined ? z.centralDirectory : (z.offsets[next] as number);
}

/** An offset `into` bytes into a member's compressed data. */
const inside = (z: Layout, name: string, into = 100) =>
  (z.offsets[name] as number) + 30 + Buffer.byteLength(name) + into;

const hex = (m: Record<string, Buffer>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString("hex")]));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vigil-dl-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function salvage(data: Buffer) {
  const path = join(tmp, "q.zip");
  writeFileSync(path, data);
  const out = join(tmp, "out");
  rmSync(out, { recursive: true, force: true });
  const result = salvageZip(path, out);
  const files = Object.fromEntries(result.recovered.map((p) => [basename(p), readFileSync(p)]));
  return { result, files };
}

describe("salvage", () => {
  test("the test zips use data descriptors like KAP's", () => {
    const z = kapZip();
    expect(z.data.readUInt16LE(6) & 0x08).toBe(0x08);
  });

  test("a complete zip", () => {
    const { result, files } = salvage(kapZip().data);
    expect([result.complete, result.lost]).toEqual([true, []]);
    expect(hex(files)).toEqual(hex(MEMBERS));
  });

  test("a cut inside a member", () => {
    const z = kapZip();
    const { result, files } = salvage(z.data.subarray(0, inside(z, "CO3_1003_2026_2.xls")));
    expect(result.complete).toBe(false);
    expect(Object.keys(files).sort()).toEqual(["CO0_1000_2026_2.xls", "CO1_1001_2026_2.xls", "CO2_1002_2026_2.xls"]);
    for (const [name, content] of Object.entries(files)) expect(content.equals(MEMBERS[name] as Buffer)).toBe(true);
    expect(result.lost).toEqual(["CO3_1003_2026_2.xls"]);
  });

  test("a cut inside a local header", () => {
    const z = kapZip();
    const nameEnd = inside(z, "CO1_1001_2026_2.xls", 0);
    // CO1's name is complete but none of its data: it is reported as lost.
    let r = salvage(z.data.subarray(0, nameEnd));
    expect([Object.keys(r.files), r.result.lost]).toEqual([["CO0_1000_2026_2.xls"], ["CO1_1001_2026_2.xls"]]);
    // Cut inside the name: the member is not known at all.
    r = salvage(z.data.subarray(0, nameEnd - 1));
    expect([Object.keys(r.files), r.result.lost]).toEqual([["CO0_1000_2026_2.xls"], []]);
  });

  test("a cut at every 97th byte never writes a wrong file", () => {
    const z = kapZip();
    for (let cut = 0; cut < z.data.length; cut += 97) {
      const { result, files } = salvage(z.data.subarray(0, cut));
      for (const [name, content] of Object.entries(files)) expect(content.equals(MEMBERS[name] as Buffer)).toBe(true);
      expect(result.lost.length).toBeLessThanOrEqual(1);
    }
  });

  test("a corrupt member is lost and the rest recovered", () => {
    const z = kapZip();
    const data = Buffer.from(z.data);
    const crcAt = memberEnd(z, "CO1_1001_2026_2.xls") - 12; // CO1's descriptor CRC
    data[crcAt] = (data[crcAt] as number) ^ 0xff;
    // Drop the end of the central directory so the local headers are scanned.
    const { result, files } = salvage(data.subarray(0, data.length - 30));
    expect(result.lost).toContain("CO1_1001_2026_2.xls");
    expect(Object.keys(files).sort()).toEqual(Object.keys(MEMBERS).filter((n) => n !== "CO1_1001_2026_2.xls"));
  });

  test("member paths cannot leave the target directory", () => {
    const z = kapZip({
      "../../evil.xls": Buffer.from("x"),
      "dir/A_1_2026_2.xls": Buffer.from("a"),
      "readme.txt": Buffer.from("t"),
    });
    const { result, files } = salvage(z.data);
    expect(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString()]))).toEqual({
      "evil.xls": "x",
      "A_1_2026_2.xls": "a",
    });
    for (const p of result.recovered) expect(dirname(p)).toBe(join(tmp, "out"));
  });
});

/** A response whose body breaks after `failAfter` bytes, like a dropped connection. */
function response(data: Buffer, failAfter?: number): Response {
  const body = failAfter === undefined ? data : data.subarray(0, failAfter);
  let sent = false;
  // The bytes are delivered first; the connection breaks on the next read (error() would discard queued chunks).
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(body));
      } else if (failAfter === undefined) controller.close();
      else controller.error(Object.assign(new Error("connection dropped"), { name: "ConnectionResetError" }));
    },
  });
  return new Response(stream);
}

function fakeServer(...responses: (() => Response)[]): [OpenUrl, string[]] {
  const calls: string[] = [];
  const open: OpenUrl = async (url) => {
    calls.push(url);
    const make = responses[calls.length - 1];
    if (!make) throw new Error("no more responses");
    return make();
  };
  return [open, calls];
}

describe("download", () => {
  test("retries until the zip is complete", async () => {
    const z = kapZip();
    const [open, calls] = fakeServer(
      () => response(z.data, 500),
      () => response(z.data),
    );
    const sleeps: number[] = [];
    const r = await downloadQuarter(2026, 2, tmp, { openUrl: open, sleep: async (s) => void sleeps.push(s) });
    expect([r.complete, r.attempts, r.recovered.length, r.lost]).toEqual([true, 2, 5, []]);
    expect(calls).toEqual(Array(2).fill("https://www.kap.org.tr/tr/api/financialTable/download/2026/2"));
    expect(sleeps).toEqual([2]);
    expect(r.errors[0]).toContain("ConnectionResetError");
    expect(readdirSync(join(tmp, "2026_2")).sort()).toEqual(Object.keys(MEMBERS).sort());
    expect(existsSync(join(tmp, "2026_2.zip.part"))).toBe(false);
  });

  test("never complete: the longest attempt is salvaged", async () => {
    const z = kapZip();
    const short = inside(z, "CO1_1001_2026_2.xls");
    const long = inside(z, "CO3_1003_2026_2.xls");
    const [open] = fakeServer(
      () => response(z.data, short),
      () => response(z.data, long),
      () => response(z.data, short),
    );
    const sleeps: number[] = [];
    const r = await downloadQuarter(2026, 2, tmp, {
      retries: 3,
      openUrl: open,
      sleep: async (s) => void sleeps.push(s),
    });
    expect([r.complete, r.attempts]).toEqual([false, 3]);
    expect(r.recovered.map((p) => basename(p)).sort()).toEqual([0, 1, 2].map((i) => `CO${i}_100${i}_2026_2.xls`));
    expect(r.lost).toEqual(["CO3_1003_2026_2.xls"]);
    expect(sleeps).toEqual([2, 4]);
  });

  test("nothing downloaded; a zip left by an earlier run is not used", async () => {
    writeFileSync(join(tmp, "2026_2.zip"), kapZip().data);
    const open: OpenUrl = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    const r = await downloadQuarter(2026, 2, tmp, { retries: 2, openUrl: open, sleep: async () => {} });
    expect([r.complete, r.recovered, r.lost, r.errors.length]).toEqual([false, [], [], 2]);
  });

  test("only the listed files are extracted", async () => {
    const [open] = fakeServer(() => response(kapZip().data));
    const wanted = ["CO1_1001_2026_2.xls", "CO3_1003_2026_2.xls"];
    const r = await downloadQuarter(2026, 2, tmp, { openUrl: open, sleep: async () => {}, only: wanted });
    expect(r.complete).toBe(true);
    expect(readdirSync(join(tmp, "2026_2")).sort()).toEqual(wanted);
  });

  test("fetchFiles reports missing files and skips files already present", async () => {
    const z = kapZip();
    const listing = join(tmp, "files.txt");
    writeFileSync(listing, "2026_2/CO0_1000_2026_2.xls\n2026_2/GONE_9_2026_2.xls\n");
    const raw = join(tmp, "raw");
    const [open, calls] = fakeServer(
      () => response(z.data),
      () => response(z.data),
    );
    const missing = await fetchFiles(listing, raw, { openUrl: open, sleep: async () => {} });
    expect(Object.fromEntries(missing)).toEqual({ "2026_2": ["GONE_9_2026_2.xls"] });
    expect(readdirSync(join(raw, "2026_2"))).toEqual(["CO0_1000_2026_2.xls"]);
    expect(existsSync(join(raw, "2026_2.zip"))).toBe(false); // only the listed files are kept

    writeFileSync(listing, "2026_2/CO0_1000_2026_2.xls\n");
    expect((await fetchFiles(listing, raw, { openUrl: open, sleep: async () => {} })).size).toBe(0);
    expect(calls).toHaveLength(1); // already present: not downloaded again
  });
});

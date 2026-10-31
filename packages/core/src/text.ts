/**
 * Text helpers that behave like the Python implementation this code was ported from (decision 0010), so that
 * every parsed label, value and message stays the same.
 */

/**
 * Whitespace as Python's `str.isspace()` / regex `\s` sees it. JavaScript's `\s` differs: it lacks \x1c-\x1f
 * and \x85 and adds ﻿.
 */
export const WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const LEADING_WS = new RegExp(`^[${WS}]+`);
const TRAILING_WS = new RegExp(`[${WS}]+$`);
const WS_RUN = new RegExp(`[${WS}]+`, "g");

/** Python `str.strip()`. */
export function strip(s: string): string {
  return s.replace(LEADING_WS, "").replace(TRAILING_WS, "");
}

/** Collapse every whitespace run to one space and strip, as `re.sub(r"\s+", " ", s).strip()`. */
export function collapseWhitespace(s: string): string {
  return strip(s.replace(WS_RUN, " "));
}

/** Python `repr()` of a string, used in error messages. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${quote}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${quote}${out}${quote}`;
}

/** Python `repr()` of a list of strings. */
export function pyReprList(items: readonly string[]): string {
  return `[${items.map(pyRepr).join(", ")}]`;
}

/**
 * Python `round(x, ndigits)`: the exact binary value of `x` rounded to `ndigits` decimals, ties to even, then
 * converted back to the nearest double. Computed exactly with bigint (x = mantissa * 2^exponent).
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  const scale = 10n ** BigInt(ndigits);
  let q: bigint;
  if (exponent >= 0) {
    q = (mantissa << BigInt(exponent)) * scale;
  } else {
    const n = mantissa * scale;
    const d = 1n << BigInt(-exponent);
    q = n / d;
    const twice = 2n * (n % d);
    if (twice > d || (twice === d && q % 2n === 1n)) q += 1n;
  }
  const result = Number(`${q}e-${ndigits}`);
  return x < 0 ? -result : result;
}

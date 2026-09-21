// Small numeric and counting helpers that must behave exactly as Python does.

/**
 * Python's round(x, n): round half to even, on the float's exact binary value.
 *
 * JavaScript has no equivalent. Math.round rounds half up, and the usual
 * Math.round(x * 100) / 100 introduces its own error in the multiplication.
 * Keyness sorts on the rounded log-likelihood, so a rounding difference would
 * reorder the ranking. This decomposes the double into mantissa and exponent
 * and rounds the exact product with BigInt, which is what Python does.
 */
export function pyRound(x, n = 2) {
  if (!Number.isFinite(x) || x === 0) return x;
  const neg = x < 0;
  const v = Math.abs(x);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  const hi = view.getUint32(0), lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (expBits === 0) e = -1074;
  else { mant |= 1n << 52n; e = expBits - 1075; }

  const scale = 10n ** BigInt(n);
  const num = mant * scale;
  let k;
  if (e >= 0) k = num << BigInt(e);
  else {
    const den = 1n << BigInt(-e);
    const q = num / den, r = num % den, twice = 2n * r;
    if (twice > den) k = q + 1n;
    else if (twice < den) k = q;
    else k = q % 2n === 0n ? q : q + 1n;          // the tie goes to even
  }
  const out = Number(k) / Number(scale);
  return neg ? -out : out;
}

/**
 * Python's Counter(...).most_common(n).
 *
 * Counts in first-seen order, then a stable sort by count, so equal counts keep
 * the order their words first appeared. That tie order decides which of several
 * equally frequent words make a top-twenty list.
 */
export function mostCommon(items, n = Infinity) {
  const counts = new Map();
  for (const x of items) counts.set(x, (counts.get(x) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** A Counter as a Map, for the lookups keyness needs. */
export function counter(items) {
  const m = new Map();
  for (const x of items) m.set(x, (m.get(x) || 0) + 1);
  return m;
}
